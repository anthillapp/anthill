/**
 * The one thing this server is told when it starts: which Anthill's data it is
 * serving.
 *
 * A flag rather than an environment variable, and that is not a style
 * preference. The server is spawned by a coding harness out of a plugin
 * configuration, and Codex passes only the variables its `env_vars` allowlist
 * names — so a server that read `ANTHILL_DATA_DIR` would work under Claude Code
 * and silently fall back to a default under Codex. A flag is written down in the
 * same configuration on both, and behaves the same on both.
 *
 * Falling back is the dangerous case, which is why an unrecognised argument is
 * refused rather than ignored. A mistyped `--data-dirr` that this parser shrugged
 * at would leave the server writing a second, empty exchange beside the real one
 * and reporting every handover as a success; the user would watch an app that
 * never opens anything. There is nothing to recover from afterwards, because
 * nothing failed.
 */

import { defaultDataDir } from "@anthill/exchange-store";
import { isAbsolute, resolve } from "node:path";

import type { Target } from "./target.js";

export type ServerOptions = {
  /** Anthill's user-data directory. The exchange is a directory inside it. */
  dataDir: string;
  /**
   * Whether a handover may bring the desktop app up.
   *
   * On by default, because a handover nobody sees is the thing this was for
   * (ANT-123). Off is for the two cases where an app appearing is wrong rather
   * than merely unwanted: a machine driving this server from a script, and the
   * end-to-end test, which speaks to a real server over a real pipe and must
   * not open an application on whoever is running it.
   */
  launch: boolean;
  /**
   * Which Anthill this is: the installed app, or the development build of a
   * checkout. The development build is never launched; see `target.ts`.
   */
  target: Target;
};

type OptionsResult =
  | { ok: true; options: ServerOptions }
  | { ok: false; message: string };

/** The flags, spelled once so the parser and the message cannot disagree. */
const DATA_DIR_FLAG = "--data-dir";
const NO_LAUNCH_FLAG = "--no-launch";
const DEV_FLAG = "--dev";

const USAGE = `anthill-mcp [${DATA_DIR_FLAG} <path>]

  ${DATA_DIR_FLAG} <path>  Absolute Anthill user-data directory, holding the exchange this
                    server writes into. Defaults to the installed desktop app's,
                    which is ${defaultDataDir()} on this machine.
  ${NO_LAUNCH_FLAG}       Do not open Anthill when a workflow is handed over. The
                    anthill:// link is still returned; nothing opens it.
  ${DEV_FLAG}             Serve the development build (\`npm run dev:desktop\`): its data
                    directory, ${defaultDataDir({ packaged: false })}, and never
                    the installed app. Also set by "target": "dev" in
                    ~/.anthill/plugin.json.`;

/**
 * Read the arguments a harness spawned this server with.
 *
 * @param argv Arguments after the executable and the script, i.e. `process.argv.slice(2)`.
 * @param fallbackDataDir Where to write when the caller says nothing. Injected
 *   so a test does not have to agree with whatever platform it is running on.
 */
export function readOptions(
  argv: readonly string[],
  fallbackDataDir: string = defaultDataDir(),
  /**
   * What `~/.anthill/plugin.json` says, and where the development build keeps
   * its data. Injected, like the fallback, so a test decides both.
   */
  settings: { target?: Target; devDataDir?: string } = {},
): OptionsResult {
  let dataDir: string | undefined;
  let launch = true;
  let dev = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === NO_LAUNCH_FLAG) {
      launch = false;
      continue;
    }

    if (argument === DEV_FLAG) {
      dev = true;
      continue;
    }

    if (argument === DATA_DIR_FLAG) {
      if (dataDir !== undefined) return { ok: false, message: `${DATA_DIR_FLAG} must be supplied only once.` };
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, message: `${DATA_DIR_FLAG} needs a path.\n\n${USAGE}` };
      }
      dataDir = value;
      index += 1;
      continue;
    }

    if (argument.startsWith(`${DATA_DIR_FLAG}=`)) {
      if (dataDir !== undefined) return { ok: false, message: `${DATA_DIR_FLAG} must be supplied only once.` };
      const value = argument.slice(`${DATA_DIR_FLAG}=`.length);
      if (value.length === 0) {
        return { ok: false, message: `${DATA_DIR_FLAG} needs a path.\n\n${USAGE}` };
      }
      dataDir = value;
      continue;
    }

    return { ok: false, message: `Unrecognised argument ${argument}.\n\n${USAGE}` };
  }

  // A flag outranks the settings file, and a data directory given outright
  // outranks both: it is the one thing that cannot be wrong about where.
  const target: Target = dev ? "dev" : (settings.target ?? "installed");
  const selected =
    dataDir ?? (target === "dev" ? (settings.devDataDir ?? defaultDataDir({ packaged: false })) : fallbackDataDir);
  if (!selected.trim() || !isAbsolute(selected)) {
    return { ok: false, message: `${DATA_DIR_FLAG} needs an absolute path; harness working directories can change.` };
  }
  return { ok: true, options: { dataDir: resolve(selected), launch, target } };
}
