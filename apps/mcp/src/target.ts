/**
 * Which Anthill this server serves: the installed app, or the development
 * build a checkout runs with `npm run dev:desktop`.
 *
 * The two keep separate data directories — `@anthill/desktop` and
 * `@anthill/desktop-dev` — and a handover is only seen by the app whose
 * exchange it was written into. Testing a change end to end through a harness
 * plugin, before anything is released, means pointing the server at the
 * development build: its exchange, and no launching of the installed app,
 * which would open a window that cannot see the handover.
 *
 * Said once, outside every plugin copy, in `~/.anthill/plugin.json` — the file
 * the plugin's launcher already reads to find this server:
 *
 * ```json
 * { "server": "/abs/checkout/apps/mcp/dist/server.js", "target": "dev" }
 * ```
 *
 * One line switches the Claude Code and the Codex plugins together, without
 * reinstalling either, and survives a plugin update; a flag would have to be
 * written into each installed copy's `.mcp.json`, and an environment variable
 * does not reach a server Codex starts. `--dev` is the same thing as a flag,
 * for a configuration that wants to say it itself.
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LaunchReport } from "./launch.js";

export type Target = "installed" | "dev";

/** The settings file the plugin's launcher reads, and where the target is said. */
export function pluginSettingsPath(home: string = homedir()): string {
  return join(home, ".anthill", "plugin.json");
}

/**
 * The target the settings file names, if it names one.
 *
 * A file that is missing, damaged, or says something else says nothing: the
 * server serves the installed app, as it always has. `"installed"` is accepted
 * too, so switching back is an edit rather than a deletion.
 */
export function readTargetSetting(file: string = pluginSettingsPath()): Target | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const target = (JSON.parse(readFileSync(file, "utf8")) as { target?: unknown })?.target;
    return target === "dev" || target === "installed" ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an Anthill is running on this data directory.
 *
 * Electron holds its single-instance lock as a `SingletonLock` link in the
 * data directory, pointing at `<host>-<pid>`. The link outlives a crash, so
 * the process it names has to be alive too; one that cannot be checked is
 * taken as not running, which only changes what the message says.
 */
export function appRunning(dataDir: string): boolean {
  try {
    const owner = readlinkSync(join(dataDir, "SingletonLock"));
    const pid = Number(owner.slice(owner.lastIndexOf("-") + 1));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The launcher for the development build.
 *
 * It opens nothing. The installed app is the only one macOS can be asked to
 * open — a development build runs as the stock Electron bundle, which is
 * every dev Electron on the machine (ANT-137) — and it cannot see this
 * handover anyway. A running development build picks the handover up from its
 * own exchange; one that is not running is named, with how to start it, so a
 * handover nobody sees is never reported as a success.
 */
export function devLauncher(dataDir: string, running: (dir: string) => boolean = appRunning) {
  return async (url: string): Promise<LaunchReport> =>
    running(dataDir)
      ? {
          outcome: "dev",
          message: `This server serves Anthill's development build, which is running and shows the handover from its own exchange (${dataDir}).`,
        }
      : {
          outcome: "dev",
          message:
            "This server serves Anthill's development build, and it is not running, so nothing shows the handover yet. " +
            `Start it from the checkout with \`npm run dev:desktop\`; the handover is stored and ${url} opens it there.`,
        };
}
