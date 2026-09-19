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
import { resolve } from "node:path";

export type ServerOptions = {
  /** Anthill's user-data directory. The exchange is a directory inside it. */
  dataDir: string;
};

export type OptionsResult =
  | { ok: true; options: ServerOptions }
  | { ok: false; message: string };

/** The flag, spelled once so the parser and the message cannot disagree. */
const DATA_DIR_FLAG = "--data-dir";

export const USAGE = `anthill-mcp [${DATA_DIR_FLAG} <path>]

  ${DATA_DIR_FLAG} <path>  Anthill's user-data directory, holding the exchange this
                    server writes into. Defaults to the installed desktop app's,
                    which is ${defaultDataDir()} on this machine.`;

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
): OptionsResult {
  let dataDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === DATA_DIR_FLAG) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, message: `${DATA_DIR_FLAG} needs a path.\n\n${USAGE}` };
      }
      dataDir = value;
      index += 1;
      continue;
    }

    if (argument.startsWith(`${DATA_DIR_FLAG}=`)) {
      const value = argument.slice(`${DATA_DIR_FLAG}=`.length);
      if (value.length === 0) {
        return { ok: false, message: `${DATA_DIR_FLAG} needs a path.\n\n${USAGE}` };
      }
      dataDir = value;
      continue;
    }

    return { ok: false, message: `Unrecognised argument ${argument}.\n\n${USAGE}` };
  }

  // Resolved against the working directory, because Codex spawns plugin servers
  // with a `cwd` of its own choosing and a relative path would mean a different
  // directory every time the harness moved. An absolute path resolves to itself.
  return { ok: true, options: { dataDir: resolve(dataDir ?? fallbackDataDir) } };
}
