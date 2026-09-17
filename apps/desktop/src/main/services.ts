/**
 * Main-process wiring: this is where `@anthill/engine`, `@anthill/runtimes`,
 * `@anthill/run-store` and `@anthill/workspace` actually live.
 *
 * None of these may be imported from the renderer — they spawn child processes
 * (the agent CLIs), read the filesystem and open a SQLite database.
 */

import {
  CodexCliRuntime,
  ClaudeCodeRuntime,
  PiCliRuntime,
  CodexAcpRuntime,
  ClaudeCodeAcpRuntime,
  type AgentRuntime,
} from "@anthill/runtimes";
import {
  WorkflowEngine,
  adaptAgentRuntime,
  getRunFailureReason,
  type ApprovalGatePort,
  type RunStorePort,
  type RuntimeAdapterPort,
} from "@anthill/engine";
import { createRunStore, type RunStore } from "@anthill/run-store";
import type { NodeRun, Workflow, WorkflowRun } from "@anthill/workflow-schema";

import type {
  ApprovalDecision,
  RunEvent,
  RuntimeInfo,
} from "../shared/ipc.js";

/** Every runtime the shell knows about, in the order they appear in the UI. */
export function createRuntimes(): AgentRuntime[] {
  return [
    new ClaudeCodeRuntime(),
    new CodexCliRuntime(),
    new PiCliRuntime(),
    // Honest placeholders: these report themselves unavailable until a real
    // ACP/MCP client exists. They are listed so the UI can show that the
    // bridge path is planned but not usable yet.
    new ClaudeCodeAcpRuntime(),
    new CodexAcpRuntime(),
  ];
}

/** Probe the host for each runtime so the UI can show what is actually usable. */
export async function detectRuntimes(
  runtimes: AgentRuntime[],
): Promise<RuntimeInfo[]> {
  return Promise.all(
    runtimes.map(async (runtime) => {
      try {
        const detection = await runtime.detect();
        return {
          id: runtime.id,
          displayName: runtime.displayName,
          available: detection.available,
          version: detection.version,
          reason: detection.reason,
        };
      } catch (error) {
        return {
          id: runtime.id,
          displayName: runtime.displayName,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * Human-in-the-loop approval, bridged over IPC.
 *
 * The engine awaits `requestApproval`; we park that promise here, ask the
 * renderer, and resolve it when the user answers. A run that is closed while
 * an approval is outstanding rejects the promise so the engine can unwind
 * instead of hanging forever.
 */
export class IpcApprovalGate implements ApprovalGatePort {
  private readonly pending = new Map<
    string,
    { resolve: (d: ApprovalDecision) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly emit: (event: RunEvent) => void) {}

  private static key(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
  }

  requestApproval(
    runId: string,
    nodeId: string,
    context: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(IpcApprovalGate.key(runId, nodeId), { resolve, reject });
      this.emit({ type: "approval-requested", runId, nodeId, context });
    });
  }

  /** Called from the IPC handler when the user clicks approve/reject. */
  respond(runId: string, nodeId: string, decision: ApprovalDecision): boolean {
    const key = IpcApprovalGate.key(runId, nodeId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    entry.resolve(decision);
    return true;
  }

  /** Fail every outstanding approval, e.g. on shutdown. */
  abandonAll(reason: string): void {
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      entry.reject(new Error(reason));
    }
  }
}

/**
 * Adapts the full `RunStore` to the narrower `RunStorePort` the engine wants,
 * and tees every write out to the renderer as a `RunEvent` so the UI can show
 * progress live rather than only at the end.
 *
 * The two interfaces differ deliberately: the store needs a workflow snapshot
 * at creation time (so run history survives later edits to the workflow) and
 * exposes a run-level status setter, neither of which the engine's port knows
 * about. This function is the seam.
 */
export function createRunStorePort(
  store: RunStore,
  snapshot: Workflow,
  emit: (event: RunEvent) => void,
): RunStorePort {
  return {
    async createRun(run: WorkflowRun): Promise<void> {
      await store.createRun(run, snapshot as unknown as Record<string, unknown>);
      emit({ type: "run-created", run });
    },
    async updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void> {
      await store.updateNodeRun(runId, nodeRun);
      emit({ type: "node-updated", runId, nodeRun });
    },
    async getRun(runId: string): Promise<WorkflowRun | undefined> {
      return store.getRun(runId);
    },
    async updateRun(run: WorkflowRun): Promise<void> {
      await store.updateRunStatus(run.id, run.status, run.finishedAt);
      emit({ type: "run-updated", run });
    },
  };
}

export type RunServices = {
  store: RunStore;
  runtimes: AgentRuntime[];
  approvals: IpcApprovalGate;
};

/**
 * Open the run store and build the runtime list. Call once at startup.
 *
 * `nativeBinding` points at the Electron-ABI build of better-sqlite3 produced
 * by `scripts/fetch-electron-sqlite.mjs` — the copy npm installs is compiled
 * for the system Node and Electron cannot load it.
 */
export async function createServices(
  runsDir: string,
  emit: (event: RunEvent) => void,
  nativeBinding?: string,
): Promise<RunServices> {
  const store = await createRunStore({ rootDir: runsDir, nativeBinding });
  return { store, runtimes: createRuntimes(), approvals: new IpcApprovalGate(emit) };
}

/**
 * Execute one workflow. Resolves with the run id as soon as the run exists so
 * the UI can start following it; the run itself continues in the background
 * and reports through `RunEvent`s.
 */
export async function startRun(
  services: RunServices,
  workflow: Workflow,
  workspacePath: string,
  emit: (event: RunEvent) => void,
): Promise<string> {
  const adapters = new Map<string, RuntimeAdapterPort>();
  for (const runtime of services.runtimes) {
    adapters.set(runtime.id, adaptAgentRuntime(runtime));
  }

  const runStorePort = createRunStorePort(services.store, workflow, emit);

  // Agent nodes without an explicit workingDirectory inherit the workspace.
  const scoped: Workflow = {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.type === "agent" && !node.config.workingDirectory
        ? { ...node, config: { ...node.config, workingDirectory: workspacePath } }
        : node,
    ),
  };

  let resolveRunId: (id: string) => void;
  let rejectRunId: (error: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  // `createRun` is the first thing the engine does, so this fires almost
  // immediately — well before the workflow finishes.
  const trackingPort: RunStorePort = {
    ...runStorePort,
    async createRun(run) {
      await runStorePort.createRun(run);
      resolveRunId(run.id);
    },
  };

  const engine = new WorkflowEngine({
    adapters,
    runStore: trackingPort,
    approvals: services.approvals,
  });

  engine
    .run(scoped)
    .then((run) => {
      const failure = getRunFailureReason(run);
      emit({
        type: "run-finished",
        run,
        failure: failure ?? undefined,
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      rejectRunId(error instanceof Error ? error : new Error(message));
      emit({
        type: "run-finished",
        run: {
          id: "unknown",
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          status: "failed",
          startedAt: new Date().toISOString(),
          nodeRuns: [],
        },
        failure: { code: "ENGINE_ERROR", message, nodeId: "" },
      });
    });

  return runIdPromise;
}
