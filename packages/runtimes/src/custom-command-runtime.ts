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

export interface CustomCommandRuntimeConfig {
  /** Executable to run. */
  command: string;
  /** Fixed arguments passed before anything else. */
  args?: readonly string[];
  /** Extra environment variables, merged over `process.env` and `ctx.environment`. */
  env?: Record<string, string>;
  /**
   * `"json"`  — scan stdout for an embedded `AgentResult` JSON block.
   * `"text"`  — never parse; always summarize stdout as free text.
   */
  outputMode: "json" | "text";
  /** Arguments used by `detect()`. Defaults to `["--version"]`. */
  versionArgs?: readonly string[];
  /** Override the runtime id/name so several custom commands can coexist. */
  id?: string;
  displayName?: string;
  /** Injectable spawn seam for tests. */
  spawnFn?: SpawnFn;
}

/**
 * Runs an arbitrary user-configured command as an Anthill agent.
 *
 * PROMPT DELIVERY: the prompt envelope is written to the child process's
 * **stdin**, which is then closed. Nothing is appended to `args` — commands
 * that want the prompt as a flag should wrap themselves in a small script.
 * This keeps arbitrarily long envelopes off the argv length limit and avoids
 * shell quoting entirely (no shell is used).
 */
export class CustomCommandRuntime implements AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  private readonly config: CustomCommandRuntimeConfig;
  private readonly spawnFn?: SpawnFn;

  constructor(config: CustomCommandRuntimeConfig) {
    this.config = config;
    this.id = config.id ?? "custom-command";
    this.displayName = config.displayName ?? `Custom command (${config.command})`;
    this.spawnFn = config.spawnFn;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectBinary({
      command: this.config.command,
      versionArgs: this.config.versionArgs,
      notFoundReason: `custom command "${this.config.command}" not found on PATH`,
      spawnFn: this.spawnFn,
    });
  }

  async run(ctx: AgentRunContext, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    const prompt = buildPromptEnvelope(ctx);
    const args = [...(this.config.args ?? [])];

    const outcome = await runProcess({
      command: this.config.command,
      args,
      cwd: ctx.workingDirectory,
      env: { ...ctx.environment, ...this.config.env },
      stdinPayload: prompt,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
      spawnFn: this.spawnFn,
    });

    const result = normalizeProcessOutput(outcome, {
      parseJson: this.config.outputMode === "json",
    });

    return {
      result,
      raw: {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        metadata: {
          runtimeId: this.id,
          command: this.config.command,
          args,
          outputMode: this.config.outputMode,
          promptDelivery: "stdin",
        },
      },
    };
  }
}
