import type { RuntimeDetection } from "./contracts.js";
import { runProcess, type SpawnFn } from "./process-runner.js";

export interface DetectBinaryOptions {
  /** Executable to probe, e.g. `codex`. */
  command: string;
  /** Arguments that make the binary print its version. Defaults to `--version`. */
  versionArgs?: readonly string[];
  /** Reason reported when the binary cannot be resolved on PATH. */
  notFoundReason?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

const DETECT_TIMEOUT_MS = 10_000;

/**
 * Probes for a CLI by running `<command> --version`.
 *
 * Never throws: a missing binary (ENOENT), a non-zero exit and a hung probe
 * all come back as `{ available: false, reason }`. Spawning the binary is
 * preferred over `command -v` because it needs no shell and behaves the same
 * on Windows.
 */
export async function detectBinary(options: DetectBinaryOptions): Promise<RuntimeDetection> {
  const {
    command,
    versionArgs = ["--version"],
    notFoundReason = `${command} CLI not found on PATH`,
    spawnFn,
    timeoutMs = DETECT_TIMEOUT_MS,
  } = options;

  const outcome = await runProcess({
    command,
    args: versionArgs,
    timeoutMs,
    spawnFn,
  });

  if (outcome.spawnError) {
    const code = outcome.spawnError.code;
    if (code === "ENOENT" || code === "EACCES" || code === undefined) {
      return { available: false, command, reason: notFoundReason };
    }
    return { available: false, command, reason: `${notFoundReason} (${code})` };
  }

  if (outcome.timedOut) {
    return {
      available: false,
      command,
      reason: `${command} did not respond to ${versionArgs.join(" ")} within ${timeoutMs}ms`,
    };
  }

  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    return {
      available: false,
      command,
      reason: detail || `${command} exited with code ${String(outcome.exitCode)}`,
    };
  }

  const version = firstLine(outcome.stdout) || firstLine(outcome.stderr);
  return version
    ? { available: true, command, version }
    : { available: true, command };
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
