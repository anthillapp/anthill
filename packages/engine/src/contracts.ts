/**
 * Contracts used by the `@anthill/engine` workflow execution engine.
 *
 * `NodeType`, `WorkflowNode`, `WorkflowEdge`, `Workflow`, `Artifact`, `Issue`,
 * `AgentResult`, `WorkflowRun` and `NodeRun` are re-exported from
 * `@anthill/workflow-schema`, the canonical workflow data model — this used
 * to be a local mirror, replaced now that the schema package exists.
 *
 * The port interfaces below are owned by this package and stay here:
 * `@anthill/runtimes` implements `RuntimeAdapterPort` (via the
 * `adaptAgentRuntime` shim in `./runtime-adapter.ts`), `@anthill/run-store`
 * implements `RunStorePort`, and the UI implements `ApprovalGatePort`.
 */

export type {
  NodeType,
  WorkflowNode,
  WorkflowEdge,
  Workflow,
  Artifact,
  IssueSeverity,
  Issue,
  AgentResultStatus,
  AgentResult,
  WorkflowRunStatus,
  NodeRunStatus,
  LogRef,
  NodeRun,
  WorkflowRun,
} from "@anthill/workflow-schema";

import type { AgentResult, Workflow, WorkflowNode, WorkflowRun, NodeRun } from "@anthill/workflow-schema";

/* ------------------------------------------------------------------ */
/* Ports (dependency-injected boundaries owned by @anthill/engine)      */
/* ------------------------------------------------------------------ */

/** Context handed to a runtime adapter for a single node attempt. */
export type RuntimeRunContext = {
  runId: string;
  nodeId: string;
  attempt: number;
  workflow: Workflow;
  node: WorkflowNode;
  inputs: Record<string, unknown>;
  /** Results of previously executed `agent`/`approval` nodes, keyed by node id. */
  priorResults: Record<string, AgentResult>;
  instructions: string;
};

/**
 * Implemented by `@anthill/runtimes` — in practice via the `adaptAgentRuntime`
 * shim in `./runtime-adapter.ts`, since `@anthill/runtimes`' `AgentRuntime.run()`
 * returns `{ result, raw }` rather than a bare `AgentResult`.
 */
export interface RuntimeAdapterPort {
  id: string;
  run(ctx: RuntimeRunContext): Promise<AgentResult>;
}

/** Implemented by `@anthill/run-store`. */
export interface RunStorePort {
  createRun(run: WorkflowRun): Promise<void>;
  updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  /**
   * Optional engine extension: persist run-level state transitions
   * (running -> paused -> success/failed/cancelled). The three methods above
   * cannot express a run status change, so the engine calls this when the
   * store provides it. Stores that omit it still satisfy the port; callers
   * then only observe progress through `updateNodeRun`.
   */
  updateRun?(run: WorkflowRun): Promise<void>;
}

/** Human-in-the-loop approval. Implemented by the UI / CLI layer. */
export interface ApprovalGatePort {
  requestApproval(
    runId: string,
    nodeId: string,
    context: Record<string, unknown>,
  ): Promise<ApprovalDecision>;
}

export type ApprovalDecision = "approved" | "rejected";

/* ------------------------------------------------------------------ */
/* Node config shapes the engine reads (all optional / defensive)      */
/* ------------------------------------------------------------------ */

export type RetryPolicy = {
  maxAttempts?: number;
};

/** Subset of `AgentNodeConfig` from the workflow model that the engine reads. */
export type AgentNodeConfig = {
  runtime?: string;
  instructions?: string;
  retryPolicy?: RetryPolicy;
};
