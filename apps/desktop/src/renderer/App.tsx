/**
 * Anthill desktop — renderer root.
 *
 * Owns the authored workflow, the selected workspace, and the live run state
 * streamed from the main process. This component performs no privileged work
 * itself: everything goes through `window.anthill` (see `src/preload`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkflowBuilder } from "@anthill/builder";
import type { NodeRun, Workflow, WorkflowRun } from "@anthill/workflow-schema";

import type {
  ApprovalDecision,
  RunEvent,
  RuntimeInfo,
  WorkspaceInfo,
} from "../shared/ipc.js";
import { RunPanel, type PendingApproval } from "./RunPanel.js";
import { SAMPLE_WORKFLOW } from "./sample-workflow.js";

export function App() {
  const [workflow, setWorkflow] = useState<Workflow>(SAMPLE_WORKFLOW);
  const [workflowPath, setWorkflowPath] = useState<string | undefined>();
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRun[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [failure, setFailure] = useState<RunPanelFailure>(null);
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<WorkflowRun[]>([]);

  /* ---------------- startup ---------------- */

  useEffect(() => {
    void window.anthill.detectRuntimes().then(setRuntimes);
    void window.anthill.listRuns().then(setHistory);
  }, []);

  /* ---------------- live run events ---------------- */

  useEffect(() => {
    return window.anthill.onRunEvent((event: RunEvent) => {
      switch (event.type) {
        case "run-created":
          setRun(event.run);
          setNodeRuns([]);
          setFailure(null);
          break;
        case "node-updated":
          setNodeRuns((current) => upsertNodeRun(current, event.nodeRun));
          break;
        case "run-updated":
          setRun(event.run);
          break;
        case "run-finished":
          setRun(event.run);
          setApproval(null);
          setFailure(event.failure ?? null);
          void window.anthill.listRuns().then(setHistory);
          break;
        case "approval-requested":
          setApproval({
            runId: event.runId,
            nodeId: event.nodeId,
            context: event.context,
          });
          break;
      }
    });
  }, []);

  /* ---------------- actions ---------------- */

  const pickWorkspace = useCallback(async () => {
    const selected = await window.anthill.selectWorkspace();
    if (!selected) return;
    setWorkspace(selected);
    const status = await window.anthill.workspaceStatus(selected.rootPath);
    setDirty(status.dirty);
  }, []);

  const openWorkflow = useCallback(async () => {
    const result = await window.anthill.openWorkflow();
    if (!result.ok) return;
    setWorkflow(result.opened.workflow);
    setWorkflowPath(result.opened.path);
  }, []);

  const saveWorkflow = useCallback(async () => {
    const saved = await window.anthill.saveWorkflow({ workflow, path: workflowPath });
    if (saved) setWorkflowPath(saved.path);
  }, [workflow, workflowPath]);

  const runWorkflow = useCallback(async () => {
    if (!workspace) return;
    setStarting(true);
    setFailure(null);
    try {
      const response = await window.anthill.startRun({
        workflow,
        workspacePath: workspace.activePath,
      });
      if (!response.ok) {
        setFailure({ code: "START_FAILED", message: response.error, nodeId: "" });
      }
    } finally {
      setStarting(false);
    }
  }, [workflow, workspace]);

  const respond = useCallback(
    (decision: ApprovalDecision) => {
      if (!approval) return;
      void window.anthill.respondToApproval({
        runId: approval.runId,
        nodeId: approval.nodeId,
        decision,
      });
      setApproval(null);
    },
    [approval],
  );

  const availableRuntimes = useMemo(
    () => runtimes.filter((runtime) => runtime.available),
    [runtimes],
  );

  const runInFlight = run?.status === "running" || run?.status === "paused";

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Anthill</span>

        <button onClick={pickWorkspace}>Select workspace…</button>
        <div className="workspace">
          {workspace ? (
            <>
              <code title={workspace.rootPath}>{workspace.rootPath}</code>
              {workspace.git?.branch ? (
                <span className="pill">{workspace.git.branch}</span>
              ) : (
                <span className="pill off">not a git repo</span>
              )}
              {dirty ? <span className="pill dirty">uncommitted changes</span> : null}
            </>
          ) : (
            <span>No workspace selected</span>
          )}
        </div>

        <span className="spacer" />

        {runtimes.map((runtime) => (
          <span
            key={runtime.id}
            className={`pill ${runtime.available ? "on" : "off"}`}
            title={runtime.reason ?? runtime.version ?? ""}
          >
            {runtime.displayName}
          </span>
        ))}

        <button onClick={openWorkflow}>Open…</button>
        <button onClick={saveWorkflow}>Save</button>
        <button
          className="primary"
          onClick={runWorkflow}
          disabled={!workspace || starting || runInFlight || availableRuntimes.length === 0}
          title={
            !workspace
              ? "Select a workspace first"
              : availableRuntimes.length === 0
                ? "No agent runtime is available on this machine"
                : undefined
          }
        >
          {runInFlight ? "Running…" : "Run workflow"}
        </button>
      </header>

      <div className="body">
        <div className="canvas-area">
          <WorkflowBuilder workflow={workflow} onChange={setWorkflow} />
        </div>

        <aside className="side">
          <RunPanel
            workflow={workflow}
            run={run}
            nodeRuns={nodeRuns}
            approval={approval}
            failure={failure}
            onRespond={respond}
          />

          <section>
            <h2>Run history</h2>
            {history.length === 0 ? (
              <p className="empty">Nothing yet.</p>
            ) : (
              history.slice(0, 12).map((item) => (
                <button
                  key={item.id}
                  className="history-item"
                  onClick={() => {
                    void window.anthill.getRun(item.id).then((stored) => {
                      if (!stored) return;
                      setRun(stored);
                      setNodeRuns(stored.nodeRuns);
                      setFailure(null);
                    });
                  }}
                >
                  <span className={`status ${item.status}`}>{item.status}</span>
                  <span className="node-name">{item.workflowId}</span>
                  <span className="when">
                    {new Date(item.startedAt).toLocaleTimeString()}
                  </span>
                </button>
              ))
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

type RunPanelFailure = { code: string; message: string; nodeId: string } | null;

/** Replace the matching attempt in place, or append it, preserving order. */
function upsertNodeRun(current: NodeRun[], incoming: NodeRun): NodeRun[] {
  const index = current.findIndex(
    (item) => item.nodeId === incoming.nodeId && item.attempt === incoming.attempt,
  );
  if (index === -1) return [...current, incoming];
  const next = current.slice();
  next[index] = incoming;
  return next;
}

export default App;
