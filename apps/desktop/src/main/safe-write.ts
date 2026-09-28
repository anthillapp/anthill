/**
 * Writing inside a folder the user chose, and nowhere else.
 *
 * Export takes a list of generated files and a root. The paths are Anthill's
 * own, so the check is not really about them: it is about what the filesystem
 * does with them. A lexical `startsWith(root + sep)` said yes to
 * `<root>/agents/file.md` whether or not `<root>/agents` was a symlink
 * pointing somewhere else entirely, and the write then landed outside the one
 * folder the user agreed to (ANT-96).
 *
 * So containment is decided after the path is real, not before. Both halves
 * matter, and they catch different things:
 *
 * - The **parent directory** is resolved through its links once it exists, so
 *   a symlinked directory anywhere along the way is seen.
 * - The **destination itself** is checked without following links, so an
 *   existing symlink at the leaf is refused rather than written through.
 *
 * Nothing here repairs a path. A refusal names the file and writes nothing,
 * because a partial export is worse than none: the user would be left with
 * some of a workflow's files in a folder and no reason to suspect the rest
 * went elsewhere.
 */

import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";

export type Destination =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** Whether `candidate` is `root` or something under it, both already real. */
function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * The real path to write one generated file to, or why it is refused.
 *
 * Resolves each existing ancestor before creating its children. Creating the
 * entire parent first would already write outside the grant through a symlink.
 *
 * The root is resolved here too, rather than assumed to have been. On macOS
 * `/tmp` is itself a link to `/private/tmp`, so a caller who passes a root
 * exactly as the user typed it would have every write compared against a path
 * the filesystem never returns — and the function would refuse everything,
 * quietly and for the wrong reason.
 */
export async function destinationInside(root: string, relative: string): Promise<Destination> {
  let realRoot: string;
  try { realRoot = await realpath(root); }
  catch (error) { return { ok: false, reason: `The chosen folder is unavailable: ${String(error)}` }; }
  const destination = resolve(realRoot, relative);
  if (!inside(realRoot, destination)) {
    return { ok: false, reason: `${relative} is outside the chosen folder` };
  }

  let parent = realRoot;
  try {
    for (const part of relativePath(realRoot, dirname(destination)).split(sep).filter(Boolean)) {
      const child = join(parent, part);
      await mkdir(child).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      parent = await realpath(child);
      if (!inside(realRoot, parent)) {
        return { ok: false, reason: `${relative} resolves outside the chosen folder` };
      }
    }
  } catch (error) {
    return { ok: false, reason: `${relative} could not be prepared: ${String(error)}` };
  }

  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    return { ok: false, reason: `${relative} could not be resolved: ${String(error)}` };
  }
  if (!inside(realRoot, realParent)) {
    return { ok: false, reason: `${relative} resolves outside the chosen folder` };
  }

  // Not `stat`: that follows the link and reports the target, which is exactly
  // what must not be written through.
  const canonicalDestination = join(realParent, relativePath(dirname(destination), destination));
  let existing;
  try { existing = await lstat(canonicalDestination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `${relative} could not be inspected: ${String(error)}` };
    }
  }
  if (existing?.isSymbolicLink()) {
    return { ok: false, reason: `${relative} is a link, and Anthill will not write through one` };
  }

  if (existing && !existing.isFile()) return { ok: false, reason: `${relative} is not a regular file` };
  return { ok: true, path: canonicalDestination };
}

/**
 * The folders the user has chosen in this session.
 *
 * A dialog is the consent, and it is asked once: the renderer keeps the folder
 * and passes it back on the next export so a decision does not become a chore.
 * That makes the root renderer-supplied, which is fine only while main can
 * still say where it came from — so the folders a dialog returned are
 * remembered here, and a root that is not among them is refused rather than
 * written to.
 *
 * Kept for the life of the process. A grant is a decision about a folder, not
 * about one copy, and expiring it would put the chore back.
 */
export class FolderGrants {
  private readonly granted = new Set<string>();

  /** Record what a dialog returned. Returns the real path that was granted. */
  async grant(chosen: string): Promise<string> {
    const real = await realpath(chosen);
    this.granted.add(real);
    return real;
  }

  /** The real root to write into, or nothing when this was never granted. */
  async resolveGranted(root: string): Promise<string | undefined> {
    const real = await realpath(root).catch(() => undefined);
    return real !== undefined && this.granted.has(real) ? real : undefined;
  }
}

/**
 * The folder an export may write to, given the one the renderer remembered.
 *
 * A folder granted in this process is used as it is. One remembered from an
 * earlier session — saved with the workflow as its run folder — is not
 * refused, which is what every re-run after a restart used to meet ("That
 * folder was not chosen in this session", and no agent files written): the
 * author is asked to confirm it, in a dialog already pointing at it, and the
 * dialog is the grant (ANT-200). Nothing is written anywhere a dialog did
 * not return.
 */
export async function rootToWrite(
  remembered: string,
  grants: FolderGrants,
  confirm: (defaultPath: string) => Promise<string | undefined>,
): Promise<{ root: string } | { cancelled: true }> {
  const granted = await grants.resolveGranted(remembered);
  if (granted) return { root: granted };
  const chosen = await confirm(remembered);
  if (!chosen) return { cancelled: true };
  return { root: await grants.grant(chosen) };
}

/** Exact workflow files opened/saved through a trusted main-process path. */
export class FileGrants {
  private readonly granted = new Set<string>();

  private async canonical(path: string): Promise<string> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info && !info.isFile()) throw new Error("The workflow destination is not a regular file.");
    return join(await realpath(dirname(path)), relativePath(dirname(path), path));
  }

  async grant(path: string): Promise<void> {
    this.granted.add(await this.canonical(resolve(path)));
  }

  async has(path: string): Promise<boolean> {
    try { return this.granted.has(await this.canonical(resolve(path))); }
    catch { return false; }
  }
}

/** One generated file, already resolved to a real destination. */
export type StagedFile = { path: string; content: string; relative: string };

export type ExportOutcome =
  | { ok: true; written: string[] }
  | { ok: false; error: string; rolledBack: boolean };

/**
 * Write every generated file, or leave the folder as it was found.
 *
 * Export used to write them one at a time straight into the chosen folder. A
 * failure part way through — a full disk, a file somebody had made read-only —
 * left the repository holding some of the new agent files beside some of the
 * old ones, matching no version of the workflow and matching the prompt the
 * user had just copied least of all (ANT-100).
 *
 * Stage all contents and byte-for-byte backups beside their destinations
 * before replacing anything. A partial staging write never truncates an
 * original, and restoring a backup uses rename rather than another disk write.
 * This is rollback on an I/O error, not a crash-atomic multi-file transaction.
 *
 * A rollback can itself fail — the disk that refused the write can refuse the
 * restore. That is reported rather than hidden, because it is the one case
 * where the user has to go and look.
 */
export async function writeAllOrNothing(files: readonly StagedFile[]): Promise<ExportOutcome> {
  const result = exportQueue.then(() => exportFiles(files));
  exportQueue = result.then(() => undefined, () => undefined);
  return result;
}

// Two exports must not back up and restore over each other's writes.
let exportQueue: Promise<void> = Promise.resolve();

async function exportFiles(files: readonly StagedFile[]): Promise<ExportOutcome> {
  const staged: Array<{ file: StagedFile; directory: string; backup?: string; committed: boolean; preserve?: boolean }> = [];

  try {
    for (const file of files) {
      if (staged.some((entry) => entry.file.path === file.path)) throw new Error(`Duplicate destination: ${file.relative}`);
      const before = await lstat(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (before && !before.isFile()) throw new Error(`${file.relative} is not a regular file`);
      const directory = await mkdtemp(join(dirname(file.path), ".anthill-export-"));
      const entry = { file, directory, backup: undefined as string | undefined, committed: false, preserve: false };
      staged.push(entry);
      if (before) {
        entry.backup = join(directory, "original");
        await copyFile(file.path, entry.backup);
        await chmod(entry.backup, before.mode & 0o777);
      }
      await writeFile(join(directory, "new"), file.content, { encoding: "utf8", flag: "wx", mode: before ? before.mode & 0o777 : 0o600 });
      if (before) await chmod(join(directory, "new"), before.mode & 0o777);
    }
    for (const entry of staged) {
      await rename(join(entry.directory, "new"), entry.file.path);
      entry.committed = true;
    }
    return { ok: true, written: files.map((file) => file.relative) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let rolledBack = true;
    const recovery: string[] = [];
    for (const entry of [...staged].reverse()) {
      if (!entry.committed) continue;
      try {
        if (entry.backup) await rename(entry.backup, entry.file.path);
        else await rm(entry.file.path, { force: true });
      } catch {
        rolledBack = false;
        entry.preserve = true;
        recovery.push(entry.backup ?? entry.file.path);
      }
    }
    return { ok: false, error: reason + (recovery.length ? `; recovery required: ${recovery.join(", ")}` : ""), rolledBack };
  } finally {
    for (const entry of staged) {
      if (!entry.preserve) await rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
