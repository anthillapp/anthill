/**
 * Where the desktop keeps its data, worked out without asking the desktop.
 *
 * The exchange lives inside Anthill's own user-data directory, and the MCP
 * server has to find that directory from a process that is not Electron and
 * must not import it. Electron computes it as `app.getPath("appData")` joined
 * with the two segments `apps/desktop/src/main/user-data.ts` pins literally —
 * so this module reproduces `getPath("appData")` per platform and then joins the
 * same two segments.
 *
 * It is a duplication, and a deliberate one. The alternatives are worse: an
 * environment variable would have to survive being passed through a harness's
 * plugin configuration, which Codex does not reliably do, and a server that
 * guessed from `cwd` would write a second, empty exchange beside the real one
 * and report success. Both sides computing the same constant from the same rule
 * is the failure mode this repository already has with the CLI's report log,
 * where the desktop hardcodes a path the CLI owns; the lesson recorded there is
 * that the path should be *passed* where it can be. So `--data-dir` wins
 * wherever the caller knows better, and this is only the default.
 *
 * Everything is injectable because none of it is testable otherwise: a function
 * that reads `process.platform` can only be tested on the platform it is
 * running on, and the Windows and Linux branches are exactly the ones nobody
 * here runs.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type DataDirEnvironment = {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  home?: string;
  /** Defaults to `process.env`. Read for `APPDATA` and `XDG_CONFIG_HOME`. */
  env?: Record<string, string | undefined>;
  /**
   * Whether to answer for an installed Anthill rather than a development one.
   *
   * Defaults to true. The two have separate stores and separate locks, and a
   * server started by hand against a development app has to be told so —
   * nothing about the server's own process says which app it is serving.
   */
  packaged?: boolean;
};

/**
 * The per-user application-data directory, as Electron computes it.
 *
 * macOS and Windows have one right answer each; Linux has `XDG_CONFIG_HOME`
 * with `~/.config` as the fallback the specification names, which is what
 * Electron uses and therefore what Anthill's data is actually under.
 */
export function appDataDir(environment: DataDirEnvironment = {}): string {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  const env = environment.env ?? process.env;

  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}

/**
 * The desktop's user-data directory: where the exchange lives by default.
 *
 * The two segments are the ones `desktopUserDataPath` writes out literally, and
 * they are literal there for a reason worth repeating: reading the location back
 * from Electron once captured a new, empty directory after a packaged build
 * renamed the app, and it was reported as a reinstall having erased somebody's
 * work. A name that is written down cannot move on its own.
 */
export function defaultDataDir(environment: DataDirEnvironment = {}): string {
  const packaged = environment.packaged ?? true;
  return join(appDataDir(environment), "@anthill", packaged ? "desktop" : "desktop-dev");
}
