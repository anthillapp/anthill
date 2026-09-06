/**
 * Whether the `codex` on this PATH reads `.codex/agents/*.toml`.
 *
 * The question matters because the alternative is misleading somebody: Anthill
 * would offer a per-agent model, write the file, and the session would quietly
 * run every step on whatever model it started with. A picker whose answer is
 * silently discarded is worse than no picker.
 *
 * **Not a version comparison.** A minimum version would be a guess — the
 * evidence available locally is that 0.147.0 lacks the feature and 0.153.3 has
 * it, and inventing a boundary between them is exactly the kind of invention
 * this must not do. So the binary is asked about itself.
 *
 * How, and why this and not something better: the CLI exposes no way to ask.
 * `codex debug prompt-input` does not list custom agents in either version,
 * `codex doctor` does not mention them, `--strict-config` is refused by the
 * subcommands that would be cheap to run, and no feature flag differs. The one
 * signal that does separate them is the path literal compiled into the
 * executable, so that is what is looked for — in the file the author's own
 * `codex` resolves to, following symlinks, because a newer copy inside some
 * application bundle says nothing about the command they will actually run.
 *
 * Read-only, and nothing is executed. The answer has three values, and the
 * third is the important one: an executable that cannot be found or read is
 * `unknown`, never `unsupported`. Being wrong in that direction would tell
 * somebody to update software that is already fine.
 */

import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { access, constants } from "node:fs/promises";

/** What Anthill can say about the installed CLI's custom-agent support. */
export type CodexAgentSupport = "supported" | "unsupported" | "unknown";

/** The literal a build that reads project-scoped custom agents contains. */
const MARKER = ".codex/agents";

/**
 * Where `codex` actually is, following symlinks.
 *
 * Resolved from PATH rather than guessed, and resolved *through* symlinks
 * because the usual install is a link into a versioned release directory —
 * reading the link itself would find nothing.
 */
export async function codexExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "codex");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Not here, or not executable. Keep looking; PATH order is the answer.
    }
  }
  return undefined;
}

/**
 * Search a file for a short marker without holding it in memory.
 *
 * The executable is a couple of hundred megabytes, so it is streamed and the
 * search stops at the first hit. Chunks are overlapped by the marker's length
 * so a match cannot be missed by falling across a boundary.
 */
function fileContains(path: string, marker: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const needle = Buffer.from(marker, "utf8");
    let tail: Uint8Array = Buffer.alloc(0);
    const stream = createReadStream(path);

    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const window: Buffer =
        tail.length > 0 ? Buffer.concat([tail, buffer]) : Buffer.from(buffer);
      if (window.includes(needle)) {
        resolve(true);
        stream.destroy();
        return;
      }
      tail = window.subarray(Math.max(0, window.length - (needle.length - 1)));
    });
    // `undefined` for a file that could not be read at all, so it never
    // becomes "unsupported" further up.
    stream.on("error", () => resolve(undefined));
    stream.on("close", () => resolve(false));
    stream.on("end", () => resolve(false));
  });
}

export async function readCodexAgentSupport(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexAgentSupport> {
  const executable = path ?? (await codexExecutablePath(env));
  // No `codex` to ask. That is a fact about the machine, not about the CLI's
  // abilities, and the connection card already says the tool is missing.
  if (!executable) return "unknown";

  try {
    const found = await fileContains(executable, MARKER);
    // Unreadable for any reason — permissions, a broken link, a filesystem
    // that will not stream. Telling somebody to update software that is
    // already fine is the one wrong answer here.
    if (found === undefined) return "unknown";
    return found ? "supported" : "unsupported";
  } catch {
    return "unknown";
  }
}
