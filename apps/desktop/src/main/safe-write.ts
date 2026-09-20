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

import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

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
 * Creates the parent directory, because the destination's reality cannot be
 * resolved until it exists. That is the only thing this does before deciding:
 * a directory inside the chosen folder is not the escape being guarded
 * against, and one outside it cannot be created without passing the check that
 * follows.
 *
 * The root is resolved here too, rather than assumed to have been. On macOS
 * `/tmp` is itself a link to `/private/tmp`, so a caller who passes a root
 * exactly as the user typed it would have every write compared against a path
 * the filesystem never returns — and the function would refuse everything,
 * quietly and for the wrong reason.
 */
export async function destinationInside(root: string, relative: string): Promise<Destination> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const destination = resolve(realRoot, relative);
  if (!inside(realRoot, destination)) {
    return { ok: false, reason: `${relative} is outside the chosen folder` };
  }

  const parent = dirname(destination);
  try {
    await mkdir(parent, { recursive: true });
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
  const existing = await lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    return { ok: false, reason: `${relative} is a link, and Anthill will not write through one` };
  }

  return { ok: true, path: destination };
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
    const real = await realpath(chosen).catch(() => resolve(chosen));
    this.granted.add(real);
    return real;
  }

  /** The real root to write into, or nothing when this was never granted. */
  async resolveGranted(root: string): Promise<string | undefined> {
    const real = await realpath(root).catch(() => undefined);
    return real !== undefined && this.granted.has(real) ? real : undefined;
  }
}
