/**
 * Live view of the current run: one row per node attempt, the pending approval
 * prompt, and the final outcome.
 *
 * Presentation only — every piece of state is pushed in from `App`, which owns
 * the IPC subscription.
 */

import type { NodeRun, Workflow, WorkflowRun } from "@anthill/workflow-schema";
import type { ApprovalDecision } from "../shared/ipc.js";

export type PendingApproval = {
  runId: string;
  nodeId: string;
  context: Record<string, unknown>;
};

export type RunPanelProps = {
  workflow: Workflow;
  run: WorkflowRun | null;
  nodeRuns: NodeRun[];
  approval: PendingApproval | null;
  failure: { code: string; message: string; nodeId: string } | null;
  onRespond: (decision: ApprovalDecision) => void;
};

function statusClass(status: string): string {
  if (status === "running" || status === "queued") return "running";
  if (status === "success") return "success";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "paused") return "paused";
  return "";
}

export function RunPanel({
  workflow,
  run,
  nodeRuns,
  approval,
  failure,
  onRespond,
}: RunPanelProps) {
  const nameFor = (nodeId: string) =>
    workflow.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;

  return (
    <section className="grow">
      <h2>Current run</h2>

      {!run && !approval ? (
        <p className="empty">
          No run yet. Pick a workspace, then press <strong>Run workflow</strong>.
        </p>
      ) : null}

      {run ? (
        <p className="summary">
          <span className={`status ${statusClass(run.status)}`}>{run.status}</span>{" "}
          <code>{run.id}</code>
        </p>
      ) : null}

      {approval ? (
        <div className="approval">
          <p>
            <strong>Approval required</strong> — {nameFor(approval.nodeId)}
          </p>
          {typeof approval.context.prompt === "string" ? (
            <p>{approval.context.prompt}</p>
          ) : null}
          <div className="actions">
            <button className="primary" onClick={() => onRespond("approved")}>
              Approve
            </button>
            <button onClick={() => onRespond("rejected")}>Reject</button>
          </div>
        </div>
      ) : null}

      {failure ? (
        <div className="error-box">
          <strong>{failure.code}</strong>
          {"\n"}
          {failure.message}
        </div>
      ) : null}

      {nodeRuns.length > 0 ? (
        <ul className="list">
          {nodeRuns.map((nodeRun) => (
            <li key={`${nodeRun.nodeId}:${nodeRun.attempt}`}>
              <span className="node-name">{nameFor(nodeRun.nodeId)}</span>
              {nodeRun.attempt > 1 ? (
                <span className="attempt">attempt {nodeRun.attempt}</span>
              ) : null}
              <span className={`status ${statusClass(nodeRun.status)}`}>
                {nodeRun.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
