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

export interface ClaudeCodeRuntimeConfig {
  /** Binary name / path. Defaults to `claude`. */
  command?: string;
  /** Passed through as `--model <model>` when set. */
  model?: string;
  /** Passed through as `--permission-mode <mode>` when set. */
  permissionMode?: string;
  /** Appended verbatim. */
  extraArgs?: readonly string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Injectable spawn seam for tests. */
  spawnFn?: SpawnFn;
}

export const CLAUDE_DEFAULT_COMMAND = "claude";

/**
 * Builds the argv for a single non-interactive Claude Code invocation.
 *
 * !!! ASSUMPTION — VERIFY AGAINST THE REAL CLI !!!
 * The shape assumed here is:
 *
 *   claude -p --output-format text [--model <model>] [--permission-mode <mode>] [...extra]
 *
 * `-p` is print (headless) mode and the prompt envelope is piped in on stdin
 * by `ClaudeCodeRuntime.run`. `--output-format text` is chosen deliberately:
 * the `json` output format wraps the response in Claude Code's own envelope,
 * which would hide the agent's `AgentResult` JSON from
 * `normalizeProcessOutput`'s scanner. Like `buildCodexArgs`, this function is
 * isolated and unit tested so the invocation shape can be corrected in one
 * place.
 */
export function buildClaudeArgs(
  _ctx: AgentRunContext,
  config: ClaudeCodeRuntimeConfig = {},
): string[] {
  const args = ["-p", "--output-format", "text"];
  if (config.model) args.push("--model", config.model);
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/** Runs the Claude Code CLI non-interactively as an Anthill agent. */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = "claude-code-cli";
  readonly displayName = "Claude Code CLI";
  private readonly config: ClaudeCodeRuntimeConfig;
  private readonly command: string;

  constructor(config: ClaudeCodeRuntimeConfig = {}) {
    this.config = config;
    this.command = config.command ?? CLAUDE_DEFAULT_COMMAND;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectBinary({
      command: this.command,
      versionArgs: ["--version"],
      notFoundReason: "claude CLI not found on PATH",
      spawnFn: this.config.spawnFn,
    });
  }

  async run(ctx: AgentRunContext, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    const prompt = buildPromptEnvelope(ctx);
    const args = buildClaudeArgs(ctx, this.config);

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
