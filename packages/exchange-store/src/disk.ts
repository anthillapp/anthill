/**
 * Every filesystem call this store makes, in one place.
 *
 * The invariant the exchange is built on is that no file it owns is ever
 * mutated. Three processes write into this tree — the app, the CLI's bridge and
 * the MCP server — and no lock covers all three: Electron's single-instance
 * lock and the CLI's `instance.lock` do not know about each other, and the
 * server is covered by neither. Rather than invent a fourth lock for them to
 * not know about either, every write claims its name in one operation the
 * kernel performs, which is atomic on every platform Anthill ships and can only
 * ever succeed for one writer.
 *
 * That is why this module exists rather than the store reaching for
 * `node:fs/promises` directly: the invariant is checkable by reading one small
 * file. Nothing here replaces the contents of a name that exists, so there is
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

import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ExclusiveWrite =
  /** The file did not exist, and now holds exactly this text. */
  | { outcome: "created" }
  /** Somebody wrote it first. This is what they wrote. */
  | { outcome: "existed"; text: string };

/**
 * How many times to resolve a created-then-deleted race before giving up.
 *
 * The case is a file that exists when the name is claimed and is gone when the
 * read-back runs, which resolves on the next pass. The budget is here so a
 * pathological thrash fails honestly rather than looping — the same reason the
 * CLI's lock has one.
 */
const MAX_ATTEMPTS = 5;

/**
 * Write a file that must not already exist.
 *
 * The content is written to a private temporary file in the same directory,
 * flushed, and only then given the name it is meant to have. `link` is what
 * makes the name exclusive: like `open(path, "wx")` it is one operation the
 * kernel performs, so two processes racing on the same path produce exactly one
 * winner and one `EEXIST`. A `writeFile` guarded by an existence check is not
 * the same thing and never has been — both callers can read "absent" and both
 * then write, and the loser's content is what survives while both believe they
 * succeeded.
 *
 * The temporary file is why this is not simply `open(path, "wx")`, which is
 * what it was. That makes the *creation* of the name atomic and says nothing
 * about its contents: between the create and the end of the write it exists at
 * zero bytes and anybody may read it. Every `EEXIST` in this store is answered
 * by reading the winner's file back, so a loser racing a 2 MB revision would
 * read an empty file and report a conflict against a record that is perfectly
 * healthy — an idempotent retry turned into an accusation. Writing the bytes
 * first and claiming the name afterwards means the name never exists
 * half-written, so a read-back is always of a whole file.
 *
 * It is also what makes an interrupted write survivable. A process that dies
 * mid-write leaves an orphan temporary file, which nothing reads and the next
 * write of that record replaces; the same crash under `open(path, "wx")` left a
 * zero-byte record under a real name, which no code in this package can ever
 * repair because repairing it would mean overwriting it.
 */
export async function createExclusive(path: string, text: string): Promise<ExclusiveWrite> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  // In the same directory, so the link below cannot cross a filesystem, and
  // named so that every listing in this package ignores it: the readers take
  // `*.json` and `*.ready` and nothing beginning with a dot.
  const temp = join(directory, `.${process.pid}-${nextTemp()}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await link(temp, path);
        return { outcome: "created" };
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }

      const existing = await readTextIfPresent(path);
      if (existing !== undefined) return { outcome: "existed", text: existing };
      // The file was there for the link and gone for the read. Somebody is
      // deleting what they just wrote; go round again rather than reporting a
      // conflict with a file that no longer exists.
    }

    throw new Error(
      `Could not settle who owns ${path}: it exists when written to and is absent when read back.`,
    );
  } finally {
    // The name now has its own link to the content, or somebody else's name
    // does. Either way this one has served its purpose.
    await removeFile(temp);
  }
}

/** Enough to tell two writes by one process apart; the pid does the rest. */
let tempCounter = 0;

function nextTemp(): string {
  tempCounter += 1;
  return `${Date.now().toString(36)}-${tempCounter}`;
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
 * Never of a record under its own name: an inbox drop is removed once a copy of
 * it is safely in `done/`, which makes consuming a drop a create followed by an
 * unlink rather than a rename. A rename would replace whatever `done/` already
 * held for that key, and replacing a file is the thing this store does not do.
 * The other caller is `createExclusive`, dropping a temporary name the content
 * no longer needs.
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
