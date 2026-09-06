/**
 * Runtime-facing contracts for `@anthill/runtimes`.
 *
 * `Artifact`, `Issue` and `AgentResult` are re-exported from
 * `@anthill/workflow-schema`, the canonical workflow data model — this used
 * to be a local mirror, replaced now that the schema package exists.
 *
 * `AgentRunContext`, `AgentRuntimeResult`, `RuntimeDetection` and
 * `AgentRuntime` are the runtime-interface proper and stay owned by this
 * package.
 */

export type {
  Artifact,
  Issue,
  IssueSeverity,
  AgentResult,
  AgentResultStatus,
} from "@anthill/workflow-schema";

import type { AgentResult, AgentResultStatus, IssueSeverity } from "@anthill/workflow-schema";

/** Everything a runtime needs in order to invoke an agent for one graph node. */
export interface AgentRunContext {
  runId: string;
  nodeId: string;
  attempt: number;
  workingDirectory: string;
  instructions: string;
  role: string;
  priorResults?: Record<string, AgentResult>;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

/** The normalized result plus the untouched process-level evidence. */
export interface AgentRuntimeResult {
  result: AgentResult;
  raw: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    transcriptPath?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Result of probing the host for a runtime's underlying CLI / bridge. */
export interface RuntimeDetection {
  available: boolean;
  command?: string;
  version?: string;
  reason?: string;
}

/**
 * The single interface the workflow engine talks to. Vendor specifics
 * (Codex CLI, Claude Code, an arbitrary shell command, a future ACP/MCP
 * bridge) live behind implementations of this interface.
 */
export interface AgentRuntime {
  id: string;
  displayName: string;
  detect(): Promise<RuntimeDetection>;
  run(context: AgentRunContext, signal?: AbortSignal): Promise<AgentRuntimeResult>;
}

/** Default wall-clock budget for a single agent invocation: 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Valid `AgentResult.status` values, exported for lenient parsing/validation. */
export const AGENT_RESULT_STATUSES: readonly AgentResultStatus[] = [
  "success",
  "failed",
  "cancelled",
  "requires_approval",
];

/** Valid `Issue.severity` values, exported for lenient parsing/validation. */
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["low", "medium", "high", "critical"];
