/**
 * What to say about where a revision stands.
 *
 * Two programs describe this state to a person: the app, in a badge on the
 * workflow it has open, and the MCP server, in the text block a coding agent
 * reads out. If each wrote its own words they would drift, and the user would
 * be told two things about one state — which of the two is true being a
 * question nobody in the conversation can settle. So the words live here,
 * once, and both sides ask for them.
 *
 * These used to be written twice over, once per handover mode, because
 * `approval-gate` made a draft something the harness was *waiting on* while
 * `show-and-go` made the same draft something it could already work from.
 * The gate is gone — it withheld the run record rather than the work — so
 * there is one vocabulary again, and none of it is about permission.
 */

import type { RevisionState } from "./contracts.js";

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
 * The prose for one revision's state.
 *
 * Total: every state has an answer, because a screen that has to fall back to
 * "unknown" is a screen that will show it to somebody.
 */
export function describeState(state: RevisionState): StateDescription {
  if (state === "bound") {
    return {
      label: "Bound to run",
      detail:
        "A run has pinned this revision. Binding alone is not evidence that the external session is running.",
      // Why the revision is frozen rather than merely discouraged from
      // changing: the prompt the agent is working from was made from this
      // content, and changing it underneath would make the two disagree
      // without either of them noticing.
      next: "This revision cannot change. Editing the workflow makes a new one; the binding keeps its original snapshot.",
    };
  }

  if (state === "ready_for_agent") {
    return {
      label: "Ready",
      detail: "This revision is complete, so the work may begin on it at any time.",
      next: "Editing it makes a new revision, and the next run picks that one up instead.",
    };
  }

  return {
    label: "Draft",
    detail:
      "The workflow has been handed over, and the work may begin on it as soon as it is complete.",
    next: "Change whatever is not right — every change is saved, and the next run picks up the latest.",
  };
}
