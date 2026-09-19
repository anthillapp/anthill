/**
 * The three things about a handover that need a sentence rather than a pill.
 *
 * A standing approval, edits that have diverged from what is running, and the
 * reason an approval cannot be recorded. Everything else about a handover fits
 * in a pill, and the seven states with nothing to say get no card at all —
 * this is not the old band returning, which was always there with five
 * paragraphs whether or not any of them applied.
 *
 * It floats over the canvas instead of sitting in the layout. The exchange is
 * re-read on a timer, so a card can appear while nobody is interacting, and
 * the canvas must not jump under the reader's cursor when it does.
 */

import type { HandoverNoticeModel } from "./handover.js";

export function HandoverNotice({
  notice,
  busy,
  onWithdraw,
}: {
  notice: HandoverNoticeModel;
  busy: boolean;
  onWithdraw: (revision: number) => void;
}) {
  return (
    <div
      className={`wf-notice${notice.tone === "error" ? " is-error" : ""}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <i aria-hidden="true" />
      <p>{notice.text}</p>
      {/*
        Withdrawing is a decision about what a *new* run may be given, and
        nothing else. Somebody reaching for it has usually just realised an
        agent is working from the wrong revision, so what it will not do is
        said in the sentence above the control rather than after they press it.
      */}
      {notice.withdraw ? (
        <button disabled={busy} onClick={() => notice.withdraw && onWithdraw(notice.withdraw.revision)}>
          {busy ? "Withdrawing..." : `Withdraw approval of revision ${notice.withdraw.revision}`}
        </button>
      ) : null}
    </div>
  );
}
