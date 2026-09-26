/**
 * What the editor says about the last time Save was pressed.
 *
 * Pressing Save on a workflow that already had a file did nothing anybody
 * could see: the write happened, the dirty pill went out, and that was the
 * whole report. On a fast disk the pill was already out, so the click produced
 * no change at all and the honest reading of the screen was "nothing happened"
 * (ANT-58).
 *
 * Two rules keep what it says true. Success is only ever shown *after* the
 * write comes back, never on the way in — a "Saved" that appears before the
 * bytes land is the one message here that must never be wrong. And a
 * cancelled dialog is not a failure and not a success: the author chose it, so
 * the indicator simply goes quiet rather than reporting on a write that was
 * never attempted.
 *
 * The wording stays in the past tense for a reason. "Saved" is a claim about
 * something that has finished; "Saving…" is a claim about right now. Nothing
 * here is ever phrased as a promise about what is about to happen.
 */

/** Where a save has got to, as far as the author needs to know. */
export type SaveStatus =
  /** Nothing to report — no save yet, or the last one has been acknowledged. */
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; error: string };

/**
 * How long "Saved" stays up.
 *
 * Long enough to be read after a glance away, short enough that it is plainly
 * about the click just made and not about the state of the document — that is
 * the dirty pill's job, and two things saying it would be one too many.
 */
export const SAVED_LINGER_MS = 2400;

/** The line to show, or nothing at all when there is nothing to say. */
export function saveMessage(status: SaveStatus): string | undefined {
  if (status.kind === "saving") return "Saving…";
  if (status.kind === "saved") return "Saved";
  // The reason, not a restatement of the obvious: the author can act on "no
  // space left on device" and can do nothing whatever with "save failed".
  if (status.kind === "failed") return `Not saved – ${status.error}`;
  return undefined;
}

/**
 * Whether this status is a fault.
 *
 * Kept apart from the message so the styling cannot drift from the meaning:
 * red belongs to a failure and nowhere else on this indicator.
 */
export function isFailure(status: SaveStatus): boolean {
  return status.kind === "failed";
}
