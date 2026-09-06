/**
 * Persistence-layer contracts for `@anthill/run-store`.
 *
 * `Artifact`, `Issue`, `AgentResult`, `LogRef`, `NodeRun` and `WorkflowRun` are
 * re-exported from `@anthill/workflow-schema`, the canonical workflow data
 * model — this used to be a local mirror, replaced now that the schema
 * package exists. `WorkflowSnapshot`, `StoredRun`, `RunFilter` and `RunStore`
 * are owned by this package.
 */

export type {
  Artifact,
  Issue,
  IssueSeverity,
  AgentResult,
  LogRef,
  NodeRun,
  NodeRunStatus,
  WorkflowRun,
  WorkflowRunStatus,
} from "@anthill/workflow-schema";

import type { NodeRun, WorkflowRun, WorkflowRunStatus, Artifact, LogRef } from "@anthill/workflow-schema";

/**
 * A workflow definition captured at the moment a run started. Stored verbatim as opaque
 * JSON so that later edits to the live workflow definition never rewrite run history.
 * The run store never inspects its contents.
 */
export type WorkflowSnapshot = Record<string, unknown>;

/** A run together with the workflow definition it was started from. */
export type StoredRun = WorkflowRun & { snapshot: WorkflowSnapshot };

export type RunFilter = {
  workflowId?: string;
  status?: WorkflowRunStatus;
};

/**
 * Persistence layer for workflow runs.
 *
 * Run/node-attempt records live in a database; artifact and log payloads live as files on
 * disk under the store's `rootDir` and are referenced from the records by path.
 */
export interface RunStore {
  /** Persist a new run along with the workflow snapshot it was started from. */
  createRun(run: WorkflowRun, snapshot: WorkflowSnapshot): Promise<void>;

  /**
   * Insert or update a single node attempt. Attempts are keyed by
   * `(runId, nodeRun.nodeId, nodeRun.attempt)`, so retries are recorded as new rows rather
   * than overwriting earlier attempts.
   */
  updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void>;

  /** Update the run-level status (and optionally stamp `finishedAt`). */
  updateRunStatus(
    runId: string,
    status: WorkflowRunStatus,
    finishedAt?: string,
  ): Promise<void>;

  /** Fetch one run with all of its node attempts and its workflow snapshot. */
  getRun(runId: string): Promise<StoredRun | undefined>;

  /** List runs (newest first), optionally filtered by workflow and/or status. */
  listRuns(filter?: RunFilter): Promise<WorkflowRun[]>;

  /**
   * Write `content` to a file under the run's artifact directory and return the artifact
   * with `path` populated. The returned artifact is what belongs in `AgentResult.artifacts`.
   */
  saveArtifact(
    runId: string,
    nodeId: string,
    artifact: Artifact,
    content: string,
  ): Promise<Artifact>;

  /**
   * Append `content` to the `(runId, nodeId, kind)` log file, creating it if needed, and
   * return the reference to it. Calling this repeatedly with the same `kind` appends to the
   * same file and returns the same stable log id/path.
   */
  appendLog(
    runId: string,
    nodeId: string,
    kind: string,
    content: string,
  ): Promise<Required<LogRef>>;

  /**
   * Release underlying resources (database handle). Optional so that backends without
   * resources to release still satisfy the interface.
   */
  close?(): Promise<void>;
}
