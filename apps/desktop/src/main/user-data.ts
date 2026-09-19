/**
 * Where the desktop keeps everything, decided before anything else runs.
 *
 * This is the first question the main process answers, ahead of the instance
 * lock and every store, so nothing here may depend on Electron being ready —
 * and a refusal here is a refusal to start at all. That is why the messages
 * quote what they were given: the person reading one is looking at a launcher
 * argument, a shortcut or a plugin config, and "requires an absolute directory
 * path" without saying which path was tried leaves them guessing which of the
 * three it came from.
 */

import { isAbsolute, join, resolve } from "node:path";

/** Keep the installed profile stable; development gets its own stores and lock. */
export function desktopUserDataPath(appData: string, isPackaged: boolean): string {
  return join(appData, "@anthill", isPackaged ? "desktop" : "desktop-dev");
}

/** An explicit profile must agree with the MCP server's --data-dir. */
export function desktopDataDirectory(argv: readonly string[], fallback: string): string {
  let selected: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg !== "--data-dir" && !arg.startsWith("--data-dir=")) continue;
    const value = arg === "--data-dir" ? argv[++i] : arg.slice("--data-dir=".length);
    if (selected !== undefined) {
      throw new Error(`--data-dir was given twice, as ${quoted(selected)} and ${quoted(value)}. Supply it once.`);
    }
    selected = value ?? "";
    if (!selected.trim() || !isAbsolute(selected)) {
      throw new Error(`--data-dir ${quoted(selected)} is not an absolute directory path.`);
    }
  }
  return selected ? resolve(selected) : fallback;
}

/**
 * What to show somebody whose data directory could not be used.
 *
 * Both ways of failing land here: an argument this build will not accept, and
 * a path the filesystem would not create — the second of which carries its own
 * path in the message the system wrote. Neither of them can be reported the way
 * everything else in the app is, because both happen before there is a window
 * to put a notice in, so the sentence has to carry the whole of what happened
 * and what to do instead.
 */
export function dataDirectoryRefusal(reason: unknown, fallback: string): string {
  const said = reason instanceof Error ? reason.message : String(reason);
  return `${said} Anthill keeps its workflows, its live-session records and its settings there and cannot start without it. Start Anthill again without --data-dir to use ${fallback}, or point the flag at a directory this account can write to.`;
}

/** A value as it was given, and legibly when it was given as nothing at all. */
function quoted(value: string | undefined): string {
  return value === undefined || value === "" ? "(nothing)" : `"${value}"`;
}
