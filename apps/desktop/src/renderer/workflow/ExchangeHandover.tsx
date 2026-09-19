import { useEffect, useState } from "react";
import { CLI_LABEL, type PendingRun } from "@anthill/live";
import { describeState, revisionDigest } from "@anthill/workflow-exchange";
import { stampWorkflowFormat } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import type { ExchangeView } from "../../shared/ipc.js";

/** Provenance and a local handover decision. No command is sent to a harness. */
export function ExchangeHandover({ workflow, path, dirty, runs }: {
  workflow: Workflow; path?: string; dirty: boolean; runs: PendingRun[];
}) {
  const [view, setView] = useState<ExchangeView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    let reading = false;
    setView(undefined);
    setError(undefined);
    const read = async () => {
      if (!path || !window.anthill.exchangeRead || reading) return;
      reading = true;
      try {
        const next = await window.anthill.exchangeRead(path, workflow.id);
        if (current) { setView(next); setError(undefined); }
      } catch (problem) {
        if (current) setError(String(problem));
      } finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => { current = false; clearInterval(timer); };
  }, [path, workflow.id, dirty, refresh]);

  if (!view) return error ? <p className="exchange-handover" role="alert">{error}</p> : null;
  const matches = revisionDigest(stampWorkflowFormat(workflow)) === view.digest;
  const description = describeState(view.state, view.mode);
  /**
   * An approval left behind by an earlier revision.
   *
   * Readiness belongs to one revision and never carries forward, so editing an
   * approved workflow leaves the head unapproved and the older approval intact
   * — and under an approval gate that older revision is what a new run is
   * given. The panel used to say "waiting for you" and nothing else, which
   * read as "nothing is authorised" while something was.
   */
  const standing = view.approved && view.approved.revision !== view.revision ? view.approved : undefined;
  const approve = async () => {
    if (!path || dirty || !matches || busy) return;
    setBusy(true);
    try {
      const result = await window.anthill.exchangeReady({ path, workflowId: workflow.id, revision: view.revision, digest: view.digest });
      if (!result.ok) setError(result.error);
      else { setError(undefined); setRefresh((value) => value + 1); }
    } catch (problem) { setError(String(problem)); }
    finally { setBusy(false); }
  };
  return (
    <section className="exchange-handover" aria-label="External handover">
      <div className="exchange-handover-heading">
        <strong>{description.label}</strong>
        <span>Revision {view.revision}</span>
        <span>{view.mode === "approval-gate" ? "Approval gate" : "Show-and-go"}</span>
        <span>From {CLI_LABEL[view.source.harness]}</span>
        <span className="spacer" />
        {view.mode === "approval-gate" && view.state === "draft" ? (
          <button disabled={busy || dirty || !matches || view.problems.length > 0 || Boolean(error)} onClick={() => void approve()}>
            {busy ? "Recording approval..." : "Ready for agent"}
          </button>
        ) : null}
      </div>
      <p>{description.detail}</p>
      {/*
        What to do about it, in the same words the MCP server reads out to the
        harness. Dropping it left the app naming a state and never saying what
        follows from it, while the agent on the other side of the handover was
        being told.
      */}
      {description.next ? <p>{description.next}</p> : null}
      {/*
        The one sentence that says what the button does not do, beside the
        button. It was inside a disclosure about provenance, which is where
        somebody goes to read the original task — not where they look before
        deciding whether pressing this starts an agent.
      */}
      <p>Ready for agent records your decision only. Anthill does not start or control the external session.</p>
      {standing ? (
        <p>
          Revision {standing.revision} is still approved{standing.at ? `, from ${new Date(standing.at).toLocaleString()}` : ""}, so
          it — not revision {view.revision} — is the one an agent may take. Approving this revision replaces that approval.
        </p>
      ) : null}
      {dirty || !matches ? <p>Unsaved or unrecorded changes are not approved. Save and review them first.</p> : null}
      {view.bindings.map((binding) => {
        const run = runs.find((item) => item.anthillRunId === binding.runId);
        const activity = run?.state === "detected_live" ? "Running" : "Bound to";
        return <p key={binding.runId}>{activity} revision {binding.revision}
          {view.revision !== binding.revision ? ` · your edits are revision ${view.revision}` : ""}
          {dirty ? " · unsaved edits" : ""}</p>;
      })}
      <details>
        <summary>Original task and source</summary>
        <p className="exchange-task">{view.source.taskText}</p>
        <p>Source session: <code>{view.source.sessionId}</code></p>
      </details>
      {view.problems.length > 0 ? <ul>{view.problems.map((problem, index) => <li key={index}>{problem.message}</li>)}</ul> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
