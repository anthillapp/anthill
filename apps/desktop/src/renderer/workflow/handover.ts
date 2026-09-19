/**
 * What a handed-over workflow's toolbar and notice card say, worked out once.
 *
 * Three surfaces read this — the pill, the primary button and the floating
 * notice — and they contradicted each other the last time each worked it out
 * for itself: a toolbar reading "No problems" beside a red problem chip on the
 * canvas, with approval enabled. So the whole state is derived here, from the
 * exchange's own answer plus the two things only the editor knows (whether the
 * document has unwritten edits, and whether the last write failed), and the
 * components render what they are handed.
 *
 * Nothing here decides anything. Anthill watches a handover; it starts, stops
 * and steers no session, and no string below may suggest otherwise.
 */

import type { PendingRun } from "@anthill/live";
import type { ExchangeView } from "../../shared/ipc.js";

/**
 * The six states, which are not the five `describeState` names.
 *
 * `describeState` is the vocabulary shared with the MCP server, which reads it
 * out to the agent, and it knows nothing about observation — so its one `bound`
 * covers both "a run pinned this revision" and "that run is reporting
 * progress". Those are different claims and the design draws them apart, in
 * words and in colour, because a binding is never evidence a session is alive.
 * The split is made here rather than in `describeState` for that reason: adding
 * liveness to it would mix what the agent is told with what we have observed.
 */
export type HandoverTone = "draft" | "waiting" | "approved" | "ready" | "bound" | "running";

export type HandoverPill = { label: string; tone: HandoverTone; title: string };

export type HandoverNoticeModel = {
  text: string;
  /** Red is only ever a failed write. A standing approval is not a fault. */
  tone: "warning" | "error";
  withdraw?: { revision: number };
};

export type HandoverModel = {
  pill: HandoverPill;
  /**
   * The approval, when it is the decision actually on offer.
   *
   * Present only under an approval gate on an unapproved head — the one place
   * this decision can be made. `blocked` carries why it cannot be pressed; the
   * button is still drawn, because a control that vanishes teaches nothing and
   * a grey one with no reason teaches only that something is wrong.
   */
  primary?: { label: "Ready for agent"; blocked?: string };
  notice?: HandoverNoticeModel;
};

export type HandoverInput = {
  view: ExchangeView;
  /** The document has edits that were never written. */
  dirty: boolean;
  /** The open document is byte-for-byte the revision the exchange holds. */
  matches: boolean;
  /**
   * The problems that block a prompt, counted once for the whole screen.
   *
   * Passed in rather than recomputed: the pill, the canvas chips and the
   * inspector each derived their own count once, and they disagreed on screen
   * at the same time.
   */
  problemCount: number;
  /** What the last approval or withdrawal did not do, if it failed. */
  writeError?: string;
  runs: PendingRun[];
};

const FAILED_WRITE =
  "The last approval was not recorded — the exchange file changed while Anthill was writing. Nothing was recorded; reload and try again.";

function pillFor(input: HandoverInput): HandoverPill {
  const { view } = input;
  const bound = view.bindings[0];
  if (view.state === "bound" && bound) {
    /*
     * "Running" is earned by the session's own reports arriving, and by
     * nothing else. A binding is a revision being pinned, which happens before
     * a session has done anything at all — and often before one starts.
     */
    const live = input.runs.some(
      (run) => run.anthillRunId === bound.runId && run.state === "detected_live",
    );
    return live
      ? {
          label: `Running revision ${bound.revision}`,
          tone: "running",
          title: "The session's own progress reports are arriving.",
        }
      : {
          label: `Bound to revision ${bound.revision}`,
          tone: "bound",
          title: `A run pinned revision ${bound.revision}. Binding alone is not evidence that the external session is running.`,
        };
  }

  if (view.state === "ready_for_agent") {
    return view.mode === "approval-gate"
      ? {
          label: "Approved",
          tone: "approved",
          title: "You approved this revision. The work may begin.",
        }
      : {
          label: "Ready",
          tone: "ready",
          title: "Show-and-go: the work may begin at any time.",
        };
  }

  return view.mode === "approval-gate"
    ? {
        label: "Waiting for you",
        tone: "waiting",
        title: "Nothing may start until you approve this revision.",
      }
    : {
        label: "Draft",
        tone: "draft",
        title:
          "Handed over while still being written. Work may begin once the session finishes describing it.",
      };
}

/**
 * Why the approval cannot be recorded, in the order a person can act on.
 *
 * The unsaved case comes first because it is the one their next keystroke
 * fixes, and because approving then would record a decision about a revision
 * they cannot see. The failed write comes last: it describes something that
 * already happened, and saying so over a blocker they could clear right now
 * would send them to reload instead.
 */
function blockedBecause(input: HandoverInput): string | undefined {
  const { view } = input;
  if (input.dirty || !input.matches)
    return `Unsaved or unrecorded changes are not approved. Save them, then approve revision ${view.revision}.`;
  if (input.problemCount > 0)
    return input.problemCount === 1
      ? "1 problem in the workflow blocks approval. Open the problems list and fix it first."
      : `${input.problemCount} problems in the workflow block approval. Open the problems list and fix them first.`;
  if (input.writeError) return FAILED_WRITE;
  return undefined;
}

function noticeFor(input: HandoverInput, blocked: string | undefined): HandoverNoticeModel | undefined {
  const { view } = input;
  /*
   * An approval left behind by an earlier revision.
   *
   * Readiness belongs to one revision and never carries forward, so editing an
   * approved workflow leaves the head unapproved and the older approval
   * intact — and under an approval gate that older revision is what a new run
   * is given. Saying only "waiting for you" read as "nothing is authorised"
   * while something was.
   */
  const standing =
    view.approved && view.approved.revision !== view.revision ? view.approved : undefined;
  if (standing) {
    /*
     * What withdrawing it would leave behind, as the store reports it.
     *
     * Not assumed to be "nothing approved": that is true only when this is the
     * one approval there is, and the panel's own controls reach the case where
     * it is not. Approve, edit, approve, edit, withdraw leaves the approval
     * from two edits ago standing, and a new run is given it immediately after
     * the user acted to stop exactly that.
     */
    const after =
      standing.below === undefined
        ? "this handover is left with nothing approved"
        : `revision ${standing.below} — approved before it and never withdrawn — becomes the one an agent may take`;
    const when = standing.at ? `, from ${new Date(standing.at).toLocaleString()}` : "";
    return {
      tone: "warning",
      text:
        `Revision ${standing.revision} is still approved${when}. You have edited since, so a run started now works from ` +
        `revision ${standing.revision} and not from what is on your canvas. Withdrawing removes that approval — it does ` +
        `not stop a session that has already started, and Anthill cannot. Withdraw it and ${after}.`,
      ...(standing.withdrawable ? { withdraw: { revision: standing.revision } } : {}),
    };
  }

  const diverged = view.bindings.find((binding) => binding.revision !== view.revision);
  if (diverged)
    return {
      tone: "warning",
      text:
        `Running revision ${diverged.revision} · your edits are revision ${view.revision}. ` +
        "Editing did not change what the session is doing, and will not.",
    };

  if (blocked)
    return { text: blocked, tone: input.writeError && blocked === FAILED_WRITE ? "error" : "warning" };
  return undefined;
}

export function handoverModel(input: HandoverInput): HandoverModel {
  const pill = pillFor(input);
  /*
   * The decision exists only where it can be made: under an approval gate, on
   * a head nobody has approved. Everywhere else the pill reports and the slot
   * holds nothing — a button offering a decision that is already taken, or
   * that this mode never asks for, would be a control with no meaning.
   */
  const offered = input.view.mode === "approval-gate" && input.view.state === "draft";
  const blocked = offered ? blockedBecause(input) : undefined;
  return {
    pill,
    ...(offered
      ? { primary: { label: "Ready for agent" as const, ...(blocked ? { blocked } : {}) } }
      : {}),
    ...((() => {
      const notice = noticeFor(input, blocked);
      return notice ? { notice } : {};
    })()),
  };
}
