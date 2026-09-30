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

import { isAbsolute, resolve } from "node:path";

import { TARGETS, readTarget, type Target } from "./target.js";

export type ServerOptions = {
  /**
   * Anthill's user-data directory, when the configuration names one outright.
   *
   * It overrides only the directory: the target still decides what is started
   * and how a result names it. Absent, the target's own directory is used (see
   * `target.ts`).
   */
  dataDir?: string;
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
   * `--target <t>`, or `--dev` for `electron-dev`: the Anthill this plugin copy
   * always serves. It outranks `~/.anthill/plugin.json`, and yields to a chat's
   * own `--dev` and to the platform; see `target.ts`.
   */
  target?: Target;
};

type OptionsResult =
  | { ok: true; options: ServerOptions }
  | { ok: false; message: string };

/** The flags, spelled once so the parser and the message cannot disagree. */
const DATA_DIR_FLAG = "--data-dir";
const NO_LAUNCH_FLAG = "--no-launch";
const TARGET_FLAG = "--target";
const DEV_FLAG = "--dev";

const USAGE = `anthill-mcp [${TARGET_FLAG} <${TARGETS.join("|")}>] [${DATA_DIR_FLAG} <path>] [${NO_LAUNCH_FLAG}]

  ${TARGET_FLAG} <t>     Which Anthill to serve: app (the installed app), electron-dev
                    (npm run dev:desktop from a checkout) or web (the web shell).
                    Without it: a chat's --dev, then "target" in
                    ~/.anthill/plugin.json, then the installed app on macOS; always
                    the web shell on Linux and Windows.
  ${DEV_FLAG}             The same as ${TARGET_FLAG} electron-dev.
  ${DATA_DIR_FLAG} <path>  Absolute Anthill user-data directory, holding the exchange this
                    server writes into. Overrides only the directory; the target's
                    own is used without it.
  ${NO_LAUNCH_FLAG}       Do not open Anthill when a workflow is handed over. The
                    anthill:// link is still returned; nothing opens it.`;

/**
 * Read the arguments a harness spawned this server with.
 *
 * @param argv Arguments after the executable and the script, i.e. `process.argv.slice(2)`.
 */
export function readOptions(argv: readonly string[]): OptionsResult {
  let dataDir: string | undefined;
  let launch = true;
  let target: Target | undefined;

  const setTarget = (value: string | undefined): string | undefined => {
    const read = readTarget(value);
    if (!read) return `${TARGET_FLAG} needs one of ${TARGETS.join(", ")}.\n\n${USAGE}`;
    if (target !== undefined && target !== read) return `${TARGET_FLAG} and ${DEV_FLAG} disagree about which Anthill to serve.`;
    target = read;
    return undefined;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === NO_LAUNCH_FLAG) {
      launch = false;
      continue;
    }

    if (argument === DEV_FLAG) {
      const problem = setTarget("electron-dev");
      if (problem) return { ok: false, message: problem };
      continue;
    }

    if (argument === TARGET_FLAG || argument.startsWith(`${TARGET_FLAG}=`)) {
      const value = argument === TARGET_FLAG ? argv[(index += 1)] : argument.slice(`${TARGET_FLAG}=`.length);
      const problem = setTarget(value);
      if (problem) return { ok: false, message: problem };
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

  if (dataDir !== undefined && (!dataDir.trim() || !isAbsolute(dataDir))) {
    return { ok: false, message: `${DATA_DIR_FLAG} needs an absolute path; harness working directories can change.` };
  }
  return {
    ok: true,
    options: {
      ...(dataDir !== undefined ? { dataDir: resolve(dataDir) } : {}),
      launch,
      ...(target ? { target } : {}),
    },
  };
}
