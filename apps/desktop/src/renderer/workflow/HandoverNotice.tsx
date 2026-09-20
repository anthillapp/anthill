/**
 * The two things about a handover that need a sentence rather than a pill.
 *
 * A run that has already taken a copy of this graph, and a change that was not
 * saved. Everything else about a handover fits in a pill, and the states with
 * nothing to say get no card at all — this is not the old band returning,
 * which was always there with five paragraphs whether or not any of them
 * applied.
 *
 * It had a third job and a control: withdrawing an approval. Both went with
 * the approval gate.
 *
 * It floats over the canvas instead of sitting in the layout. The exchange is
 * re-read on a timer, so a card can appear while nobody is interacting, and
 * the canvas must not jump under the reader's cursor when it does.
 */

import type { HandoverNoticeModel } from "./handover.js";

export function HandoverNotice({ notice }: { notice: HandoverNoticeModel }) {
  return (
    <div
      className={`wf-notice${notice.tone === "error" ? " is-error" : ""}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <i aria-hidden="true" />
      <p>{notice.text}</p>
    </div>
  );
}
