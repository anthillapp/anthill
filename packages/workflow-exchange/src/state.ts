/**
 * What to say about where a revision stands.
 *
 * Two programs describe this state to a person: the app, in a badge and a line
 * of explanation on the workflow it has open, and the MCP server, in the text
 * block a coding agent reads out. If each wrote its own words they would drift,
 * and the user would be told two things about one state — which of the two is
 * true being a question nobody in the conversation can settle. So the words
 * live here, once, and both sides ask for them.
 *
 * The mode is part of the answer, not decoration. Under `approval-gate` a draft
 * is something the harness is *waiting on*; under `show-and-go` the same draft
 * is something it may already be working from. Saying "draft" to the user
 * without saying which of those is the case tells them nothing they can act on.
 */

import type { HandoverMode, RevisionState } from "./contracts.js";

export type StateDescription = {
  /** Two or three words, for a badge. Capitalised as a label, not a sentence. */
  label: string;
  /** One sentence: what is true right now. */
  detail: string;
  /**
   * What happens next, or what the user could do about it.
   *
   * Absent where there is nothing to say — never filled with encouragement.
   */
  next?: string;
};

/**
 * The prose for one revision's state under one handover mode.
 *
 * Total over both: every combination has an answer, because a screen that has
 * to fall back to "unknown" is a screen that will show it to somebody.
 */
export function describeState(state: RevisionState, mode: HandoverMode): StateDescription {
  if (state === "bound") {
    return {
      label: "Running",
      detail:
        "A run is working from this revision, and its progress appears on the Live Session page.",
      // Why the revision is frozen rather than merely discouraged from
      // changing: the prompt the agent is working from was made from this
      // content, and changing it underneath would make the two disagree
      // without either of them noticing.
      next: "This revision cannot change now. Editing the workflow makes a new one, and the run in flight keeps the one it started from.",
    };
  }

  if (state === "ready_for_agent") {
    return mode === "approval-gate"
      ? {
          label: "Approved",
          detail: "You approved this revision, so the work may begin on it.",
          next: "Editing it now makes a new revision, which would need approving in turn.",
        }
      : {
          label: "Ready",
          detail: "This revision is complete, so the work may begin on it at any time.",
          next: "Editing it makes a new revision, and the next run picks that one up instead.",
        };
  }

  return mode === "approval-gate"
    ? {
        label: "Waiting for you",
        detail:
          "The workflow has been handed over and nothing is running. It waits here until you approve this revision.",
        next: "Read it through, change whatever is not right, then mark it ready.",
      }
    : {
        label: "Draft",
        detail:
          "The workflow has been handed over, and the work may begin on it as soon as it is complete.",
        next: "Change whatever is not right — every save makes a new revision, and the next run picks up the latest one.",
      };
}
