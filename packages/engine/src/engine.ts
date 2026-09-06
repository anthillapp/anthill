import type {
  AgentResult,
  ApprovalDecision,
  ApprovalGatePort,
  NodeRun,
  RunStorePort,
  RuntimeAdapterPort,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStatus,
} from "./contracts.js";
import { deepClone, randomId } from "./clone.js";
import { ExpressionError, evaluateExpression } from "./expression.js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/** Thrown before a run is created when the graph itself is unusable. */
export class WorkflowValidationError extends EngineError {
  readonly issues: string[];

  constructor(workflowId: string, issues: string[]) {
    super(`Workflow "${workflowId}" is not executable:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

/**
 * Thrown when a workflow reaches a node type the engine cannot execute yet.
 * Currently only `command` nodes, which will be handled by the custom command
 * runtime in `@anthill/runtimes`. The run is persisted as `failed` before this
 * is thrown; `runId` / `nodeId` let the caller fetch it from the run store.
 */
export class NotImplementedError extends EngineError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(message: string, runId: string, nodeId: string) {
    super(message);
    this.name = "NotImplementedError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/* ------------------------------------------------------------------ */
/* Public option / result types                                        */
/* ------------------------------------------------------------------ */

export type EngineLimits = {
  /** Used when a node has no `config.retryPolicy.maxAttempts`. */
  maxAttemptsDefault?: number;
  /** Hard ceiling on node executions across the whole run. */
  maxTotalNodeExecutions?: number;
  /** Hard ceiling on wall-clock duration of the run. */
  maxDurationMs?: number;
};

export const DEFAULT_LIMITS: Required<EngineLimits> = {
  maxAttemptsDefault: 1,
  maxTotalNodeExecutions: 100,
  maxDurationMs: 10 * 60 * 1000,
};

export type WorkflowEngineOptions = {
  /** Runtime adapters keyed by the value of an agent node's `config.runtime`. */
  adapters: Map<string, RuntimeAdapterPort>;
  runStore: RunStorePort;
  approvals: ApprovalGatePort;
  limits?: EngineLimits;
  /** Injectable clock (tests, deterministic traces). Defaults to `new Date()`. */
  now?: () => Date;
  /** Injectable id source. Defaults to `crypto.randomUUID()` when available. */
  newId?: () => string;
};

export type RunOptions = {
  /** Run-level inputs handed to every agent node as `ctx.inputs`. */
  inputs?: Record<string, unknown>;
};

export type EngineErrorCode =
  | "MAX_ATTEMPTS_EXCEEDED"
  | "MAX_NODE_EXECUTIONS_EXCEEDED"
  | "MAX_DURATION_EXCEEDED"
  | "NO_MATCHING_EDGE"
  | "NODE_FAILED"
  | "NODE_CANCELLED"
  | "UNKNOWN_RUNTIME"
  | "INVALID_CONDITION"
  | "APPROVAL_FAILED"
  | "NOT_IMPLEMENTED"
  | "END_NODE_FAILURE"
  | "RUN_INCOMPLETE";

export type RunFailure = {
  code: EngineErrorCode;
  message: string;
  nodeId: string;
};

/** Metadata key the engine stamps onto the `AgentResult` that explains a failure. */
export const ENGINE_ERROR_CODE_KEY = "engineErrorCode";
export const ENGINE_ERROR_MESSAGE_KEY = "engineErrorMessage";

/**
 * Recover the reason a run ended in `failed` / `cancelled`.
 *
 * `WorkflowRun` (per the canonical schema) has no error field, so the engine
 * records the reason on the last node run's result metadata.
 */
export function getRunFailureReason(run: WorkflowRun): RunFailure | undefined {
  for (let i = run.nodeRuns.length - 1; i >= 0; i -= 1) {
    const nodeRun = run.nodeRuns[i];
    const metadata = nodeRun?.result?.metadata;
    if (!metadata) continue;
    const code = metadata[ENGINE_ERROR_CODE_KEY];
    if (typeof code === "string") {
      const message = metadata[ENGINE_ERROR_MESSAGE_KEY];
      return {
        code: code as EngineErrorCode,
        message: typeof message === "string" ? message : (nodeRun?.result?.summary ?? code),
        nodeId: nodeRun!.nodeId,
      };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Internal execution state                                            */
/* ------------------------------------------------------------------ */

type ExecutionState = {
  workflow: Workflow;
  run: WorkflowRun;
  nodesById: Map<string, WorkflowNode>;
  outgoing: Map<string, WorkflowEdge[]>;
  /** Accumulated structured results, keyed by node id — the condition context. */
  context: Record<string, AgentResult>;
  attempts: Map<string, number>;
  totalExecutions: number;
  startedAtMs: number;
  inputs: Record<string, unknown>;
  finished: boolean;
};

/** Result of executing one node: where to go next, or "the run is over". */
type StepOutcome = { next: string[] } | { stopped: true };

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

export class WorkflowEngine {
  private readonly adapters: Map<string, RuntimeAdapterPort>;
  private readonly runStore: RunStorePort;
  private readonly approvals: ApprovalGatePort;
  private readonly limits: Required<EngineLimits>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: WorkflowEngineOptions) {
    this.adapters = options.adapters;
    this.runStore = options.runStore;
    this.approvals = options.approvals;
    this.limits = { ...DEFAULT_LIMITS, ...stripUndefined(options.limits ?? {}) };
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomId;
  }

  /**
   * Walk `workflow` from its `start` node to an `end` node (or to a failure).
   *
   * Always resolves with the final `WorkflowRun` — including for failed runs —
   * except for `command` nodes, which reject with `NotImplementedError`, and
   * structurally invalid graphs, which reject with `WorkflowValidationError`
   * before any run is created.
   */
  async run(workflow: Workflow, options: RunOptions = {}): Promise<WorkflowRun> {
    const startNode = validateWorkflow(workflow);

    const startedAt = this.now();
    const run: WorkflowRun = {
      id: `run_${this.newId()}`,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: "running",
      startedAt: startedAt.toISOString(),
      nodeRuns: [],
    };
    await this.runStore.createRun(clone(run));

    const state: ExecutionState = {
      workflow,
      run,
      nodesById: new Map(workflow.nodes.map((node) => [node.id, node])),
      outgoing: groupEdgesBySource(workflow.edges),
      context: {},
      attempts: new Map(),
      totalExecutions: 0,
      startedAtMs: startedAt.getTime(),
      inputs: { ...(options.inputs ?? {}) },
      finished: false,
    };

    const queue: string[] = [startNode.id];

    while (queue.length > 0 && !state.finished) {
      const nodeId = queue.shift()!;
      const node = state.nodesById.get(nodeId)!;

      const elapsedMs = this.now().getTime() - state.startedAtMs;
      if (elapsedMs > this.limits.maxDurationMs) {
        await this.failRun(
          state,
          node,
          "MAX_DURATION_EXCEEDED",
          `Run exceeded the maximum duration of ${this.limits.maxDurationMs}ms ` +
            `(elapsed ${elapsedMs}ms) before executing node "${node.id}".`,
        );
        break;
      }

      if (state.totalExecutions >= this.limits.maxTotalNodeExecutions) {
        await this.failRun(
          state,
          node,
          "MAX_NODE_EXECUTIONS_EXCEEDED",
          `Run exceeded the maximum of ${this.limits.maxTotalNodeExecutions} total node ` +
            `executions before executing node "${node.id}".`,
        );
        break;
      }

      const maxAttempts = this.resolveMaxAttempts(node);
      const attempt = (state.attempts.get(node.id) ?? 0) + 1;
      if (attempt > maxAttempts) {
        await this.failRun(
          state,
          node,
          "MAX_ATTEMPTS_EXCEEDED",
          `Node "${node.id}" (${node.name}) reached its attempt limit of ${maxAttempts}. ` +
            `Raise config.retryPolicy.maxAttempts or break the loop.`,
          attempt,
        );
        break;
      }

      state.attempts.set(node.id, attempt);
      state.totalExecutions += 1;

      const outcome = await this.executeNode(state, node, attempt);
      if ("next" in outcome) {
        for (const nextId of outcome.next) {
          // Fan-in de-duplication: a node already waiting in the queue is not
          // enqueued twice, so a diamond (a -> b, a -> c, b -> d, c -> d) runs
          // the join node once, after both branches. This is not a full join —
          // `d` runs when the queue reaches it, not when every branch is proven
          // complete — but it keeps simple diamonds from burning attempts.
          if (!queue.includes(nextId)) queue.push(nextId);
        }
      }
    }

    if (!state.finished) {
      // Defensive: every non-terminal path either enqueues work or fails.
      const lastNodeId = state.run.nodeRuns.at(-1)?.nodeId ?? startNode.id;
      const lastNode = state.nodesById.get(lastNodeId) ?? startNode;
      await this.failRun(
        state,
        lastNode,
        "RUN_INCOMPLETE",
        `Run drained its work queue without reaching an "end" node.`,
      );
    }

    return clone(state.run);
  }

  /* ---------------------------------------------------------------- */
  /* Node execution                                                    */
  /* ---------------------------------------------------------------- */

  private async executeNode(
    state: ExecutionState,
    node: WorkflowNode,
    attempt: number,
  ): Promise<StepOutcome> {
    const nodeRun: NodeRun = {
      id: nodeRunId(state.run.id, node.id, attempt),
      nodeId: node.id,
      attempt,
      status: "running",
      startedAt: this.now().toISOString(),
    };
    await this.recordNodeRun(state, nodeRun);

    switch (node.type) {
      case "start":
      case "condition":
        // Pure routing: no adapter call, no contribution to the condition
        // context. `condition` nodes route against results already accumulated.
        nodeRun.status = "success";
        nodeRun.finishedAt = this.now().toISOString();
        await this.recordNodeRun(state, nodeRun);
        return this.route(state, node, nodeRun);

      case "agent":
        return this.executeAgentNode(state, node, nodeRun, attempt);

      case "approval":
        return this.executeApprovalNode(state, node, nodeRun);

      case "command":
        return this.executeCommandNode(state, node, nodeRun);

      case "end":
        return this.executeEndNode(state, node, nodeRun);

      default: {
        const unknownType: string = (node as WorkflowNode).type;
        nodeRun.status = "failed";
        nodeRun.finishedAt = this.now().toISOString();
        nodeRun.result = engineFailureResult(
          "NOT_IMPLEMENTED",
          `Node "${node.id}" has unsupported type "${unknownType}".`,
        );
        await this.recordNodeRun(state, nodeRun);
        await this.finishRun(state, "failed");
        return { stopped: true };
      }
    }
  }

  private async executeAgentNode(
    state: ExecutionState,
    node: WorkflowNode,
    nodeRun: NodeRun,
    attempt: number,
  ): Promise<StepOutcome> {
    const runtimeId = readString(node.config, "runtime");
    if (!runtimeId) {
      return this.failNodeRun(
        state,
        nodeRun,
        "UNKNOWN_RUNTIME",
        `Agent node "${node.id}" (${node.name}) has no "runtime" in its config.`,
      );
    }

    const adapter = this.adapters.get(runtimeId);
    if (!adapter) {
      return this.failNodeRun(
        state,
        nodeRun,
        "UNKNOWN_RUNTIME",
        `No runtime adapter registered for "${runtimeId}" (node "${node.id}"). ` +
          `Registered: ${[...this.adapters.keys()].map((k) => `"${k}"`).join(", ") || "none"}.`,
      );
    }

    let result: AgentResult;
    try {
      result = await adapter.run({
        runId: state.run.id,
        nodeId: node.id,
        attempt,
        workflow: state.workflow,
        node,
        inputs: state.inputs,
        priorResults: { ...state.context },
        instructions: readString(node.config, "instructions") ?? "",
      });
    } catch (error) {
      result = {
        status: "failed",
        summary: `Runtime "${runtimeId}" threw: ${errorMessage(error)}`,
        artifacts: [],
        issues: [],
        metadata: { runtime: runtimeId, threw: true },
      };
    }

    nodeRun.result = result;
    nodeRun.finishedAt = this.now().toISOString();

    if (result.status === "cancelled") {
      nodeRun.status = "failed";
      nodeRun.result = stampEngineError(
        result,
        "NODE_CANCELLED",
        `Node "${node.id}" (${node.name}) was cancelled: ${result.summary}`,
      );
      await this.recordNodeRun(state, nodeRun);
      await this.finishRun(state, "cancelled");
      return { stopped: true };
    }

    if (result.status === "failed") {
      const maxAttempts = this.resolveMaxAttempts(node);
      if (attempt < maxAttempts) {
        // Retry policy: a retry is a new attempt of the same node, not a new run.
        nodeRun.status = "failed";
        await this.recordNodeRun(state, nodeRun);
        return { next: [node.id] };
      }
      nodeRun.status = "failed";
      nodeRun.result = stampEngineError(
        result,
        "NODE_FAILED",
        `Node "${node.id}" (${node.name}) failed after ${attempt} attempt(s): ${result.summary}`,
      );
      await this.recordNodeRun(state, nodeRun);
      await this.finishRun(state, "failed");
      return { stopped: true };
    }

    // "success" and "requires_approval" both flow on; routing decides where.
    state.context[node.id] = result;
    nodeRun.status = "success";
    await this.recordNodeRun(state, nodeRun);
    return this.route(state, node, nodeRun);
  }

  private async executeApprovalNode(
    state: ExecutionState,
    node: WorkflowNode,
    nodeRun: NodeRun,
  ): Promise<StepOutcome> {
    nodeRun.status = "paused";
    await this.recordNodeRun(state, nodeRun);
    state.run.status = "paused";
    await this.persistRun(state);

    let decision: ApprovalDecision;
    try {
      decision = await this.approvals.requestApproval(state.run.id, node.id, {
        nodeName: node.name,
        config: node.config,
        inputs: state.inputs,
        priorResults: { ...state.context },
      });
    } catch (error) {
      state.run.status = "running";
      return this.failNodeRun(
        state,
        nodeRun,
        "APPROVAL_FAILED",
        `Approval gate for node "${node.id}" (${node.name}) threw: ${errorMessage(error)}`,
      );
    }

    state.run.status = "running";
    await this.persistRun(state);

    const result: AgentResult = {
      status: "success",
      summary: `Approval ${decision} for "${node.name}".`,
      decision,
      artifacts: [],
      issues: [],
      metadata: { kind: "approval", decision },
    };
    state.context[node.id] = result;
    nodeRun.result = result;
    nodeRun.status = "success";
    nodeRun.finishedAt = this.now().toISOString();
    await this.recordNodeRun(state, nodeRun);

    return this.route(state, node, nodeRun, decision);
  }

  private async executeCommandNode(
    state: ExecutionState,
    node: WorkflowNode,
    nodeRun: NodeRun,
  ): Promise<StepOutcome> {
    const message =
      `Command nodes are not implemented yet (node "${node.id}" / ${node.name}). ` +
      `They will be executed by the custom command runtime in @anthill/runtimes.`;
    nodeRun.status = "failed";
    nodeRun.finishedAt = this.now().toISOString();
    nodeRun.result = engineFailureResult("NOT_IMPLEMENTED", message);
    await this.recordNodeRun(state, nodeRun);
    await this.finishRun(state, "failed");
    throw new NotImplementedError(message, state.run.id, node.id);
  }

  private async executeEndNode(
    state: ExecutionState,
    node: WorkflowNode,
    nodeRun: NodeRun,
  ): Promise<StepOutcome> {
    const failed = readString(node.config, "status") === "failed";
    const summary =
      readString(node.config, "summary") ??
      (failed ? `Workflow ended at failure node "${node.name}".` : `Workflow completed.`);

    nodeRun.status = failed ? "failed" : "success";
    nodeRun.finishedAt = this.now().toISOString();
    nodeRun.result = failed
      ? engineFailureResult("END_NODE_FAILURE", summary)
      : { status: "success", summary, artifacts: [], issues: [], metadata: { kind: "end" } };
    await this.recordNodeRun(state, nodeRun);
    await this.finishRun(state, failed ? "failed" : "success");
    return { stopped: true };
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                           */
  /* ---------------------------------------------------------------- */

  private async route(
    state: ExecutionState,
    node: WorkflowNode,
    nodeRun: NodeRun,
    decision?: ApprovalDecision,
  ): Promise<StepOutcome> {
    const edges = state.outgoing.get(node.id) ?? [];
    const matched: WorkflowEdge[] = [];

    for (const edge of edges) {
      if (edge.condition && edge.condition.trim() !== "") {
        try {
          if (evaluateExpression(edge.condition, state.context)) matched.push(edge);
        } catch (error) {
          const detail =
            error instanceof ExpressionError ? error.message : errorMessage(error);
          return this.failNodeRun(
            state,
            nodeRun,
            "INVALID_CONDITION",
            `Edge "${edge.id}" (${node.id} -> ${edge.target}) has an unusable condition: ${detail}`,
            { keepNodeRunStatus: true },
          );
        }
        continue;
      }

      if (decision !== undefined && edge.label !== undefined) {
        // Approval routing: labels select the branch, case-insensitively.
        if (edge.label.trim().toLowerCase() === decision) matched.push(edge);
        continue;
      }

      // Unconditional edge.
      matched.push(edge);
    }

    if (matched.length === 0) {
      const describe = decision !== undefined ? ` for decision "${decision}"` : "";
      return this.failNodeRun(
        state,
        nodeRun,
        "NO_MATCHING_EDGE",
        `No outgoing edge of node "${node.id}" (${node.name}) matched${describe}. ` +
          `Node is not terminal, so the run cannot continue. ` +
          `Outgoing edges: ${edges.length === 0 ? "none" : edges.map(describeEdge).join(", ")}.`,
        { keepNodeRunStatus: true },
      );
    }

    return { next: matched.map((edge) => edge.target) };
  }

  /* ---------------------------------------------------------------- */
  /* Run / node-run bookkeeping                                        */
  /* ---------------------------------------------------------------- */

  private resolveMaxAttempts(node: WorkflowNode): number {
    const retryPolicy = node.config?.["retryPolicy"];
    if (retryPolicy && typeof retryPolicy === "object") {
      const raw = (retryPolicy as Record<string, unknown>)["maxAttempts"];
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
        return Math.floor(raw);
      }
    }
    return this.limits.maxAttemptsDefault;
  }

  /** Upsert a node run into the in-memory trace and the run store. */
  private async recordNodeRun(state: ExecutionState, nodeRun: NodeRun): Promise<void> {
    const index = state.run.nodeRuns.findIndex((existing) => existing.id === nodeRun.id);
    const snapshot = clone(nodeRun);
    if (index === -1) state.run.nodeRuns.push(snapshot);
    else state.run.nodeRuns[index] = snapshot;
    await this.runStore.updateNodeRun(state.run.id, clone(nodeRun));
  }

  private async persistRun(state: ExecutionState): Promise<void> {
    await this.runStore.updateRun?.(clone(state.run));
  }

  private async finishRun(state: ExecutionState, status: WorkflowRunStatus): Promise<void> {
    state.run.status = status;
    state.run.finishedAt = this.now().toISOString();
    state.finished = true;
    await this.persistRun(state);
  }

  /** Fail the run, attributing the reason to a node run that already exists. */
  private async failNodeRun(
    state: ExecutionState,
    nodeRun: NodeRun,
    code: EngineErrorCode,
    message: string,
    options: { keepNodeRunStatus?: boolean } = {},
  ): Promise<StepOutcome> {
    if (!options.keepNodeRunStatus) nodeRun.status = "failed";
    nodeRun.finishedAt ??= this.now().toISOString();
    nodeRun.result = nodeRun.result
      ? stampEngineError(nodeRun.result, code, message)
      : engineFailureResult(code, message);
    await this.recordNodeRun(state, nodeRun);
    await this.finishRun(state, "failed");
    return { stopped: true };
  }

  /** Fail the run before/without executing a node (limit breaches). */
  private async failRun(
    state: ExecutionState,
    node: WorkflowNode,
    code: EngineErrorCode,
    message: string,
    attempt = state.attempts.get(node.id) ?? 0,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const nodeRun: NodeRun = {
      id: `${nodeRunId(state.run.id, node.id, attempt)}:error`,
      nodeId: node.id,
      attempt,
      status: "failed",
      startedAt: timestamp,
      finishedAt: timestamp,
      result: engineFailureResult(code, message),
    };
    await this.recordNodeRun(state, nodeRun);
    await this.finishRun(state, "failed");
  }
}

/* ------------------------------------------------------------------ */
/* Validation + helpers                                                */
/* ------------------------------------------------------------------ */

/** Structural checks that must hold before a run is created. */
export function validateWorkflow(workflow: Workflow): WorkflowNode {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const node of workflow.nodes ?? []) {
    if (seen.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
    seen.add(node.id);
  }

  const startNodes = (workflow.nodes ?? []).filter((node) => node.type === "start");
  if (startNodes.length === 0) issues.push(`no "start" node`);
  if (startNodes.length > 1) {
    issues.push(
      `expected exactly one "start" node, found ${startNodes.length} ` +
        `(${startNodes.map((n) => `"${n.id}"`).join(", ")})`,
    );
  }

  for (const edge of workflow.edges ?? []) {
    if (!seen.has(edge.source)) {
      issues.push(`edge "${edge.id}" has unknown source "${edge.source}"`);
    }
    if (!seen.has(edge.target)) {
      issues.push(`edge "${edge.id}" has unknown target "${edge.target}"`);
    }
  }

  if (issues.length > 0) throw new WorkflowValidationError(workflow.id, issues);
  return startNodes[0]!;
}

function groupEdgesBySource(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const grouped = new Map<string, WorkflowEdge[]>();
  for (const edge of edges ?? []) {
    const list = grouped.get(edge.source);
    if (list) list.push(edge);
    else grouped.set(edge.source, [edge]);
  }
  return grouped;
}

function nodeRunId(runId: string, nodeId: string, attempt: number): string {
  return `${runId}:${nodeId}:${attempt}`;
}

function engineFailureResult(code: EngineErrorCode, message: string): AgentResult {
  return {
    status: "failed",
    summary: message,
    artifacts: [],
    issues: [],
    metadata: { [ENGINE_ERROR_CODE_KEY]: code, [ENGINE_ERROR_MESSAGE_KEY]: message },
  };
}

function stampEngineError(
  result: AgentResult,
  code: EngineErrorCode,
  message: string,
): AgentResult {
  return {
    ...result,
    metadata: {
      ...result.metadata,
      [ENGINE_ERROR_CODE_KEY]: code,
      [ENGINE_ERROR_MESSAGE_KEY]: message,
    },
  };
}

function describeEdge(edge: WorkflowEdge): string {
  const guard = edge.condition
    ? `condition \`${edge.condition}\``
    : edge.label
      ? `label "${edge.label}"`
      : "unconditional";
  return `"${edge.id}" -> "${edge.target}" (${guard})`;
}

function readString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function clone<T>(value: T): T {
  return deepClone(value);
}
