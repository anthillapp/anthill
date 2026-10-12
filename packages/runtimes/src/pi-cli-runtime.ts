import {
  DEFAULT_TIMEOUT_MS,
  type AgentRunContext,
  type AgentRuntime,
  type AgentRuntimeResult,
  type RuntimeDetection,
} from "./contracts.js";
import { detectBinary } from "./detect-binary.js";
import { normalizeProcessOutput } from "./normalize-output.js";
import { type SpawnFn } from "./process-runner.js";
import { buildPromptEnvelope } from "./prompt-envelope.js";
import { runPiRpc } from "./pi-rpc.js";

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
 * Builds the argv for a single pi invocation in **RPC mode**.
 *
 * The shape is:
 *
 *   pi --mode rpc [--model <model>] [--thinking <level>] [...extra]
 *
 * where `--mode rpc` is pi's documented programmatic interface: the prompt
 * goes in as a JSON `prompt` command on stdin, the run's events come back
 * on stdout as JSONL, and the child stays alive until the adapter ends it.
 * Normal CLI options (`--model`, `--thinking`, …) are accepted in RPC mode
 * too. The prompt envelope is not an argument — it is sent as the `prompt`
 * command by `PiCliRpcRuntime.run`, which is how the envelope reaches it.
 * Verified against pi 1.0.1 (2026-10-10, `docs/design/rpc-seam-poc.md`):
 * `get_state` answered in 7 ms, a `prompt` command ran to `agent_settled`
 * with the full event stream live. Like `buildCodexArgs` and
 * `buildClaudeArgs`, this function is deliberately isolated and unit tested
 * so the invocation shape can be corrected in one place, without touching
 * spawning, normalization or the rest of the adapter.
 */
export function buildPiArgs(
  _ctx: AgentRunContext,
  config: PiCliRuntimeConfig = {},
): string[] {
  const args = ["--mode", "rpc"];
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/**
 * Runs the pi CLI as an Anthill agent, in RPC mode.
 *
 * The run is observed over pi's own event stream — `message_end` records
 * (the authoritative final message, with `stopReason` and `usage`) and
 * `agent_settled` (the run's own ending record) — and the child is
 * terminated when the run settles. That is what `runPiRpc` exists for; a
 * `pi -p` child would have ended itself. The adapter does not send
 * `abort`, `steer` or `next_turn`: it submits the prompt, observes, and
 * ends the child. See `docs/design/rpc-seam-poc.md` for the measured
 * event sequence this relies on.
 */
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

    const outcome = await runPiRpc({
      command: this.command,
      args,
      cwd: ctx.workingDirectory,
      env: { ...ctx.environment, ...this.config.env },
      prompt,
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
          promptDelivery: "rpc-prompt-command",
        },
      },
    };
  }
}
