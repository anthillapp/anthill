/**
 * The one time observation is allowed to interrupt.
 *
 * A modal is a strong claim, so it is gated on the only evidence strong enough
 * to carry it: a confirmed match, where the session's own records contain the
 * marker Anthill copied with the prompt. `ambiguous_match` and a run that
 * merely went quiet stay in the chip and its popover, because "something might
 * be yours" is not worth taking someone off what they were doing.
 *
 * Shown once per run. The set below lives for as long as the window does, so
 * navigating back to the workflow does not re-announce a session already
 * announced — and an app restart does, which is right: after a restart the
 * author has not been told.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

import { CLI_LABEL, type PendingRun } from "@anthill/live";

import { PresenceChip } from "./PresenceChip.js";

const announced = new Set<string>();

/** Whether this run still owes the author an announcement. */
export function shouldAnnounce(run: PendingRun): boolean {
  return run.state === "detected_live" && !announced.has(run.anthillRunId);
}

/** Remember that it was made, so it is not made twice. */
export function markAnnounced(runId: string): void {
  announced.add(runId);
}

/** Test seam. The set is module state precisely so it outlives a remount. */
export function forgetAnnouncements(): void {
  announced.clear();
}

export type SessionStartedDialogProps = {
  run: PendingRun;
  workflowName: string;
  onOpenSession: () => void;
  onDismiss: () => void;
};

export function SessionStartedDialog({
  run,
  workflowName,
  onOpenSession,
  onDismiss,
}: SessionStartedDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return createPortal(
    <div
      className="session-started-backdrop"
      onClick={onDismiss}
      role="presentation"
    >
      <div
        className="session-started"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-started-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-started-top">
          <PresenceChip run={run} presence="receiving" size="small" />
          <button
            type="button"
            className="session-started-close"
            onClick={onDismiss}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <h2 id="session-started-title">A session started running this workflow</h2>
        <p className="session-started-how">
          {run.evidenceChannel === "anthill:report"
            ? `${CLI_LABEL[run.selectedCli]} reported progress through the Anthill CLI with this run's ID and nonce.`
            : `${CLI_LABEL[run.selectedCli]} wrote matching local session evidence for this workflow.`}
        </p>

        <dl className="session-started-facts">
          <dt>Workflow</dt>
          <dd>{run.workflowName ?? workflowName}</dd>
          <dt>Session</dt>
          <dd>
            <code>{run.detectedSessionId ?? "–"}</code>
          </dd>
          <dt>Evidence</dt>
          <dd>{run.evidenceChannel === "anthill:report" ? "run ID and nonce in a CLI report" : "run marker in the session record · confirmed"}</dd>
        </dl>

        <p className="session-started-boundary">
          Anthill did not start it and cannot answer it. Observation changes nothing about
          the session.
        </p>

        <div className="session-started-actions">
          <button type="button" className="primary" onClick={onOpenSession}>
            Open the live session
          </button>
          <button type="button" onClick={onDismiss}>
            Stay in the workflow
          </button>
          <span className="session-started-esc">Esc</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
