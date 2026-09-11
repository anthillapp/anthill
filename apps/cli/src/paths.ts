import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the CLI keeps its own files.
 *
 * The desktop reads these from `app.getPath("userData")` /
 * `app.getPath("home")` (see `apps/desktop/src/main/recents.ts`); the CLI
 * has no Electron, so the same two paths come from here. `Paths` is the
 * shape both shells will share once `recents.ts` is refactored to accept
 * it (task 1, step 4). The desktop uses `userData` for the recent-workflow
 * store and `home` to shorten a path to `~/...`; the CLI provides both.
 */
export type Paths = {
  /** The CLI's own data directory: `~/.anthill/cli` by default. */
  userData: string;
  /** The user's home directory. */
  home: string;
};

/** The default data directory, relative to the user's home. */
const DEFAULT_DATA_DIR = ".anthill/cli";

/**
 * Resolve the CLI's paths.
 *
 * `--data-dir` wins over the default `~/.anthill/cli` (and is resolved to an
 * absolute path so the rest of the CLI can rely on it). `--workspace` and the
 * recent-workflow store live under `userData`.
 */
export async function resolvePaths(options?: {
  dataDir?: string;
}): Promise<Paths> {
  const home = homedir();
  const dataDir = options?.dataDir;
  const userData = dataDir ? resolve(dataDir) : join(home, DEFAULT_DATA_DIR);
  return { userData, home };
}

/**
 * Ensure the data directory exists (idempotent).
 *
 * Called before anything writes into it (the instance lock, the recent
 * workflow store).
 */
export async function ensureDataDir(paths: Paths): Promise<void> {
  await mkdir(paths.userData, { recursive: true });
}
