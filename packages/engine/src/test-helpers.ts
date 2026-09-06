/**
 * In-memory fakes and graph builders used by the engine tests.
 *
 * These are deliberately dumb stand-ins for the real adapters that will live in
 * `@anthill/runtimes` (`RuntimeAdapterPort`), `@anthill/run-store`
 * (`RunStorePort`), and the UI (`ApprovalGatePort`). No processes, no disk.
 */

import type {
  AgentResult,
  ApprovalDecision,
  ApprovalGatePort,
  NodeRun,
  RunStorePort,
  RuntimeAdapterPort,
  RuntimeRunContext,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "./contracts.js";
import { deepClone } from "./clone.js";

/* ------------------------------------------------------------------ */
/* Result builders                                                     */
/* ------------------------------------------------------------------ */

export function agentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    status: "success",
    summary: "ok",
    artifacts: [],
    issues: [],
    metadata: {},
    ...partial,
  };
}

/* ------------------------------------------------------------------ */
/* Fake runtime adapter                                                */
/* ------------------------------------------------------------------ */

export type AdapterBehavior =
  | AgentResult
  | ((ctx: RuntimeRunContext) => AgentResult | Promise<AgentResult>);

/**
 * A runtime adapter whose result is scripted per node id.
 *
 * - a single `AgentResult` / function is used for every attempt of that node
 * - an array is consumed one entry per attempt (the last entry repeats)
 */
export class FakeRuntimeAdapter implements RuntimeAdapterPort {
  readonly id: string;
  readonly calls: RuntimeRunContext[] = [];
  private readonly script: Map<string, AdapterBehavior[]>;
  private readonly fallback: AdapterBehavior;

  constructor(
    id: string,
    script: Record<string, AdapterBehavior | AdapterBehavior[]> = {},
    fallback: AdapterBehavior = agentResult(),
  ) {
    this.id = id;
    this.fallback = fallback;
    this.script = new Map(
      Object.entries(script).map(([nodeId, behavior]) => [
        nodeId,
        Array.isArray(behavior) ? behavior : [behavior],
      ]),
    );
  }

  async run(ctx: RuntimeRunContext): Promise<AgentResult> {
    this.calls.push(deepClone(ctx));
    const behaviors = this.script.get(ctx.nodeId);
    const behavior = behaviors
      ? (behaviors[Math.min(ctx.attempt - 1, behaviors.length - 1)] ?? this.fallback)
      : this.fallback;
    return typeof behavior === "function" ? behavior(ctx) : deepClone(behavior);
  }

  /** Node ids in the order the adapter was invoked. */
  callOrder(): string[] {
    return this.calls.map((call) => call.nodeId);
  }
}

/** An adapter that always throws — for exercising the failure path. */
export class ThrowingRuntimeAdapter implements RuntimeAdapterPort {
  readonly id: string;
  private readonly message: string;

  constructor(id: string, message = "runtime exploded") {
    this.id = id;
    this.message = message;
  }

  async run(): Promise<AgentResult> {
    throw new Error(this.message);
  }
}

/* ------------------------------------------------------------------ */
/* Fake run store                                                      */
/* ------------------------------------------------------------------ */

type StoreEvent =
  | { kind: "createRun"; run: WorkflowRun }
  | { kind: "updateRun"; run: WorkflowRun }
  | { kind: "updateNodeRun"; runId: string; nodeRun: NodeRun };

export class FakeRunStore implements RunStorePort {
  readonly events: StoreEvent[] = [];
  private readonly runs = new Map<string, WorkflowRun>();

  async createRun(run: WorkflowRun): Promise<void> {
    this.events.push({ kind: "createRun", run: deepClone(run) });
    this.runs.set(run.id, deepClone(run));
  }

  async updateRun(run: WorkflowRun): Promise<void> {
    this.events.push({ kind: "updateRun", run: deepClone(run) });
    this.runs.set(run.id, deepClone(run));
  }

  async updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void> {
    this.events.push({ kind: "updateNodeRun", runId, nodeRun: deepClone(nodeRun) });
    const run = this.runs.get(runId);
    if (!run) throw new Error(`FakeRunStore: unknown run "${runId}"`);
    const index = run.nodeRuns.findIndex((existing) => existing.id === nodeRun.id);
    if (index === -1) run.nodeRuns.push(deepClone(nodeRun));
    else run.nodeRuns[index] = deepClone(nodeRun);
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? deepClone(run) : undefined;
  }

  /** Every run status the store observed, in order. */
  runStatuses(): string[] {
    return this.events
      .filter((event): event is Extract<StoreEvent, { run: WorkflowRun }> => "run" in event)
      .map((event) => event.run.status);
  }

  nodeRunEvents(): NodeRun[] {
    return this.events
      .filter((event): event is Extract<StoreEvent, { nodeRun: NodeRun }> => "nodeRun" in event)
      .map((event) => event.nodeRun);
  }
}

/** A run store that implements only the three required port methods. */
export class MinimalRunStore implements RunStorePort {
  readonly nodeRuns: NodeRun[] = [];
  private readonly runs = new Map<string, WorkflowRun>();

  async createRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, deepClone(run));
  }

  async updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void> {
    this.nodeRuns.push(deepClone(nodeRun));
    void runId;
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    return this.runs.get(runId);
  }
}

/* ------------------------------------------------------------------ */
/* Fake approval gate                                                  */
/* ------------------------------------------------------------------ */

export class FakeApprovalGate implements ApprovalGatePort {
  readonly requests: { runId: string; nodeId: string; context: Record<string, unknown> }[] = [];
  private readonly decisions: ApprovalDecision[];
  private readonly onRequest?: (nodeId: string) => void;

  constructor(
    decisions: ApprovalDecision | ApprovalDecision[] = "approved",
    onRequest?: (nodeId: string) => void,
  ) {
    this.decisions = Array.isArray(decisions) ? [...decisions] : [decisions];
    this.onRequest = onRequest;
  }

  async requestApproval(
    runId: string,
    nodeId: string,
    context: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    this.requests.push({ runId, nodeId, context: deepClone(context) });
    this.onRequest?.(nodeId);
    // Yield to the microtask queue so a paused run is observably paused.
    await Promise.resolve();
    const index = Math.min(this.requests.length - 1, this.decisions.length - 1);
    return this.decisions[index] ?? "approved";
  }
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/** Deterministic clock; every read advances by `stepMs`. */
export function fakeClock(stepMs = 0, startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
  let current = startMs;
  return {
    now: (): Date => {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

/** Sequential id source so run ids are stable in assertions. */
export function fakeIds(prefix = "id"): () => string {
  let counter = 0;
  return () => `${prefix}${(counter += 1)}`;
}

/* ------------------------------------------------------------------ */
/* Graph builders                                                      */
/* ------------------------------------------------------------------ */

export function node(
  id: string,
  type: WorkflowNode["type"],
  config: Record<string, unknown> = {},
  name = id,
): WorkflowNode {
  return { id, type, name, config };
}

export function agentNode(
  id: string,
  config: Record<string, unknown> = {},
  name = id,
): WorkflowNode {
  return node(id, "agent", { runtime: "fake", instructions: `do ${id}`, ...config }, name);
}

export function edge(
  source: string,
  target: string,
  extra: { condition?: string; label?: string; id?: string } = {},
): WorkflowEdge {
  return {
    id: extra.id ?? `${source}->${target}${extra.label ? `:${extra.label}` : ""}`,
    source,
    target,
    ...(extra.condition === undefined ? {} : { condition: extra.condition }),
    ...(extra.label === undefined ? {} : { label: extra.label }),
  };
}

export function workflow(
  id: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  version = "1.0.0",
): Workflow {
  return { id, name: id, version, nodes, edges };
}
