import {
  DEFAULT_TIMEOUT_MS,
  type AgentRunContext,
  type AgentRuntime,
  type AgentRuntimeResult,
  type RuntimeDetection,
} from "./contracts.js";
import { detectBinary } from "./detect-binary.js";
import { normalizeProcessOutput } from "./normalize-output.js";
import { runProcess, type SpawnFn } from "./process-runner.js";
import { buildPromptEnvelope } from "./prompt-envelope.js";

export interface PiCliRuntimeConfig {
  /** Binary name / path. Defaults to `pi`. */
  command?: string;
  /** Passed through as `--model <model>` when set. */
  model?: string;
  /** Passed through as `--thinking <level>` when set. */
  thinking?: string;
  /** Appended verbatim. */
  extraArgs?: readonly string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Injectable spawn seam for tests. */
  spawnFn?: SpawnFn;
}

export const PI_DEFAULT_COMMAND = "pi";

/**
 * Builds the argv for a single non-interactive pi invocation.
 *
 * The shape is:
 *
 *   pi -p [--model <model>] [--thinking <level>] [...extra]
 *
 * where `-p` is print (non-interactive) mode: pi processes the prompt and
 * exits, and the prompt envelope is piped in on stdin by `PiCliRuntime.run`
 * — a piped prompt is merged into the initial prompt, which is how the
 * envelope reaches it. The reply is printed to stdout in the default text
 * mode, and the session is saved to pi's own session store, which is what
 * the pi observer reads. Verified against pi 0.85.1 (2026-09-11):
 * `echo "Reply with exactly: OK" | pi -p --no-tools` printed `OK` and exited
 * 0. Like `buildCodexArgs` and `buildClaudeArgs`, this function is
 * deliberately isolated and unit tested so the invocation shape can be
 * corrected in one place, without touching spawning, normalization or the
 * rest of the adapter.
 */
export function buildPiArgs(
  _ctx: AgentRunContext,
  config: PiCliRuntimeConfig = {},
): string[] {
  const args = ["-p"];
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/** Runs the pi CLI non-interactively as an Anthill agent. */
export class PiCliRuntime implements AgentRuntime {
  readonly id = "pi-cli";
  readonly displayName = "Pi";
  private readonly config: PiCliRuntimeConfig;
  private readonly command: string;

  constructor(config: PiCliRuntimeConfig = {}) {
    this.config = config;
    this.command = config.command ?? PI_DEFAULT_COMMAND;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectBinary({
      command: this.command,
      versionArgs: ["--version"],
      notFoundReason: "pi CLI not found on PATH",
      spawnFn: this.config.spawnFn,
    });
  }

  async run(ctx: AgentRunContext, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    const prompt = buildPromptEnvelope(ctx);
    const args = buildPiArgs(ctx, this.config);

    const outcome = await runProcess({
      command: this.command,
      args,
      cwd: ctx.workingDirectory,
      env: { ...ctx.environment, ...this.config.env },
      stdinPayload: prompt,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
      spawnFn: this.config.spawnFn,
    });

    return {
      result: normalizeProcessOutput(outcome),
      raw: {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        metadata: {
          runtimeId: this.id,
          command: this.command,
          args,
          promptDelivery: "stdin",
        },
      },
    };
  }
}
