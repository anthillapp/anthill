/**
 * Every filesystem call this store makes, in one place.
 *
 * The invariant the exchange is built on is that no file it owns is ever
 * mutated. Three processes write into this tree — the app, the CLI's bridge and
 * the MCP server — and no lock covers all three: Electron's single-instance
 * lock and the CLI's `instance.lock` do not know about each other, and the
 * server is covered by neither. Rather than invent a fourth lock for them to
 * not know about either, every write is an exclusive create, which is atomic on
 * every platform Anthill ships and can only ever succeed for one writer.
 *
 * That is why this module exists rather than the store reaching for
 * `node:fs/promises` directly: the invariant is checkable by reading one small
 * file. There is no `writeFile` here, no `rename` and no `truncate`, so there is
 * nowhere in the store a file can be overwritten.
 *
 * `EEXIST` is not an error here, it is the answer: somebody else got there
 * first, and what they wrote comes back so the caller can decide whether that
 * was the same claim (a retry, and therefore a success) or a different one (a
 * conflict, reported with both sides named and nothing overwritten). Every
 * other filesystem failure — a full disk, a permission — is left to propagate.
 * The stores elsewhere in Anthill swallow their write errors because losing a
 * status dot is better than taking the app down; losing a revision is not, and
 * a store that silently forgets what a person approved would be worse than one
 * that says it could not.
 */

import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type ExclusiveWrite =
  /** The file did not exist, and now holds exactly this text. */
  | { outcome: "created" }
  /** Somebody wrote it first. This is what they wrote. */
  | { outcome: "existed"; text: string };

/**
 * How many times to resolve a created-then-deleted race before giving up.
 *
 * The case is a file that exists when the create runs and is gone when the
 * read-back runs, which resolves on the next pass. The budget is here so a
 * pathological thrash fails honestly rather than looping — the same reason the
 * CLI's lock has one.
 */
const MAX_ATTEMPTS = 5;

/**
 * Write a file that must not already exist.
 *
 * `open(path, "wx")` is `O_CREAT | O_EXCL`: the create and the exclusivity
 * check are one operation the kernel performs, so two processes racing on the
 * same path produce exactly one winner and one `EEXIST`. A `writeFile` guarded
 * by an existence check is not the same thing and never has been — both callers
 * can read "absent" and both then write, and the loser's content is what
 * survives while both believe they succeeded.
 */
export async function createExclusive(path: string, text: string): Promise<ExclusiveWrite> {
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(text, "utf8");
      } finally {
        await handle.close();
      }
      return { outcome: "created" };
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }

    const existing = await readTextIfPresent(path);
    if (existing !== undefined) return { outcome: "existed", text: existing };
    // The file was there for the create and gone for the read. Somebody is
    // deleting what they just wrote; go round again rather than reporting a
    // conflict with a file that no longer exists.
  }

  throw new Error(
    `Could not settle who owns ${path}: it exists when written to and is absent when read back.`,
  );
}

/** A file's contents, or `undefined` when there is no such file. */
export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A directory's entries, or nothing when the directory is not there.
 *
 * An absent directory and an empty one mean the same thing to every caller
 * here: no revisions yet, no bindings yet, nothing in the inbox. The store
 * creates directories on the way to writing a file and never up front, so
 * "absent" is the ordinary state rather than an unusual one.
 */
export async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

/**
 * Remove a file, tolerating its already being gone.
 *
 * The one deletion in the store, and it is never of a record: an inbox drop is
 * removed once a copy of it is safely in `done/`, which makes consuming a drop
 * a create followed by an unlink rather than a rename. A rename would replace
 * whatever `done/` already held for that key, and replacing a file is the thing
 * this store does not do.
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
