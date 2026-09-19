import { useEffect, useState } from "react";
import { CLI_LABEL, type PendingRun } from "@anthill/live";
import { describeState, revisionDigest } from "@anthill/workflow-exchange";
import { stampWorkflowFormat } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import type { ExchangeReadyResult, ExchangeView } from "../../shared/ipc.js";

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
  /**
   * What withdrawing it would leave behind, as the store reports it.
   *
   * The panel used to promise that withdrawing left the handover with nothing
   * approved. That is true only when this is the one approval there is, and
   * the panel's own controls reach the case where it is not: approve, edit,
   * approve, edit, withdraw leaves the approval from two edits ago standing,
   * and a new run is given it immediately after the user acted to stop exactly
   * that. So the consequence is read rather than assumed, and the approval
   * underneath can be withdrawn in its turn — recording one re-reads the
   * exchange, which brings back the older approval with a control of its own.
   */
  const afterWithdrawal = standing?.below === undefined
    ? "this handover is left with nothing approved"
    : `revision ${standing.below} — approved before it and never withdrawn — becomes the one an agent may take`;
  // Both decisions are recorded the same way: ask main, show what it says, and
  // read the exchange again so the panel describes what is now on disk rather
  // than what was just asked for.
  const record = async (decide: () => Promise<ExchangeReadyResult>) => {
    setBusy(true);
    try {
      const result = await decide();
      if (!result.ok) setError(result.error);
      else { setError(undefined); setRefresh((value) => value + 1); }
    } catch (problem) { setError(String(problem)); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!path || dirty || !matches || busy) return;
    await record(() => window.anthill.exchangeReady({ path, workflowId: workflow.id, revision: view.revision, digest: view.digest }));
  };
  const withdraw = async () => {
    if (!path || !standing || busy) return;
    await record(() => window.anthill.exchangeRevoke({ path, workflowId: workflow.id, revision: standing.revision }));
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
        <>
          <p>
            Revision {standing.revision} is still approved{standing.at ? `, from ${new Date(standing.at).toLocaleString()}` : ""}, so
            it — not revision {view.revision} — is the one an agent may take. Approving this revision replaces that approval.
          </p>
          {/*
            Withdrawing is a decision about what a new run may be given, and
            nothing else. Somebody reaching for it has often just realised an
            agent is working from the wrong revision, so the sentence that
            tells them what it will not do belongs above the control and not
            after they have pressed it.
          */}
          {standing.withdrawable ? (
            <>
              <p>
                Withdrawing it means no new run may be given revision {standing.revision}, and {afterWithdrawal}. A
                run already bound to revision {standing.revision} keeps running and keeps reporting; withdrawing
                does not stop it. Revision {standing.revision} cannot be approved again afterwards — approve
                revision {view.revision} when that is what an agent should work from.
              </p>
              <button disabled={busy} onClick={() => void withdraw()}>
                {busy ? "Withdrawing approval..." : `Withdraw approval of revision ${standing.revision}`}
              </button>
            </>
          ) : null}
        </>
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
