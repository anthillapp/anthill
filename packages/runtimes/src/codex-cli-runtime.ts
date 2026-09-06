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

export interface CodexCliRuntimeConfig {
  /** Binary name / path. Defaults to `codex`. */
  command?: string;
  /** Passed through as `--model <model>` when set. */
  model?: string;
  /**
   * Adds `--skip-git-repo-check`, needed when the workspace is not a git repo.
   * Off by default because the flag is part of the assumed CLI surface below.
   */
  skipGitRepoCheck?: boolean;
  /** Appended verbatim before the trailing prompt marker. */
  extraArgs?: readonly string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Injectable spawn seam for tests. */
  spawnFn?: SpawnFn;
}

export const CODEX_DEFAULT_COMMAND = "codex";

/**
 * Builds the argv for a single non-interactive Codex CLI invocation.
 *
 * !!! ASSUMPTION — VERIFY AGAINST THE REAL CLI !!!
 * The shape assumed here is:
 *
 *   codex exec --cd <workingDirectory> [--model <model>] [--skip-git-repo-check] [...extra] -
 *
 * where `exec` is the non-interactive subcommand and the trailing `-` tells
 * Codex to read the prompt from stdin (the prompt envelope is written there by
 * `CodexCliRuntime.run`). This function is deliberately isolated and unit
 * tested so the invocation shape can be corrected in one place, without
 * touching spawning, normalization or the rest of the adapter.
 */
export function buildCodexArgs(ctx: AgentRunContext, config: CodexCliRuntimeConfig = {}): string[] {
  const args = ["exec", "--cd", ctx.workingDirectory];
  if (config.model) args.push("--model", config.model);
  if (config.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  args.push("-");
  return args;
}

/** Runs the OpenAI Codex CLI non-interactively as an Anthill agent. */
export class CodexCliRuntime implements AgentRuntime {
  readonly id = "codex-cli";
  readonly displayName = "OpenAI Codex CLI";
  private readonly config: CodexCliRuntimeConfig;
  private readonly command: string;

  constructor(config: CodexCliRuntimeConfig = {}) {
    this.config = config;
    this.command = config.command ?? CODEX_DEFAULT_COMMAND;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectBinary({
      command: this.command,
      versionArgs: ["--version"],
      notFoundReason: "codex CLI not found on PATH",
      spawnFn: this.config.spawnFn,
    });
  }

  async run(ctx: AgentRunContext, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    const prompt = buildPromptEnvelope(ctx);
    const args = buildCodexArgs(ctx, this.config);

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
