/**
 * How each observed run state is drawn.
 *
 * Two rules decide everything here, and both come from what Anthill can
 * honestly claim:
 *
 * - **Red means failure and nothing else.** The two kinds of waiting are drawn
 *   apart — `queued` is faded and still, `needsYou` is amber and moves slowly —
 *   so "the workflow has not got here yet" can never be misread as "something went
 *   wrong".
 * - **Motion never carries state on its own.** Every state is distinguishable
 *   by colour, border weight, opacity and a word, so the diagram stays fully
 *   legible with animation switched off.
 *
 * `running` is deliberately given an indeterminate bar and a flowing edge
 * rather than a percentage: Anthill is reading a log, not measuring progress,
 * and a progress bar would be a number it does not have.
 *
 * A live state is carried by the block's own border rather than by a ring drawn
 * outside it, so `border` on those states is the state's own colour and not a
 * pale tint of it: it is the only outline the block has.
 *
 * `observing` belongs to the boundary blocks alone and never comes out of the
 * fold. A session can be plainly alive — tool calls arriving, the log growing —
 * before it announces its first step, and drawing Start as finished during that
 * stretch says the workflow has moved when only the session has.
 */

import type { BlockRunState } from "@anthill/live";

export type RunStateStyle = {
  /** The word on the card. */
  label: string;
  /** What the card's own kicker says while in this state. */
  kicker: string;
  line: string;
  ink: string;
  fill: string;
  border: string;
  borderWidth: number;
  opacity: number;
  /** Whether this state animates when motion is allowed. */
  moves: boolean;
};

/**
 * Every state the diagram draws.
 *
 * One more than the fold produces: Start and End carry no work of their own, so
 * they take a state from the session rather than from an announcement, and one
 * of those has no equivalent among the observed states.
 */
export type DrawnRunState = BlockRunState | "observing";

export const RUN_STATE: Record<DrawnRunState, RunStateStyle> = {
  queued: {
    label: "Waiting its turn",
    kicker: "Queued",
    line: "#bab6b6",
    ink: "#8a8584",
    fill: "#ffffff",
    border: "#e2dfdf",
    borderWidth: 1,
    opacity: 0.62,
    moves: false,
  },
  observing: {
    label: "Waiting for the first step",
    kicker: "Observing",
    line: "#7f9db3",
    ink: "#4c667a",
    fill: "#ffffff",
    border: "#9fb6c6",
    borderWidth: 2,
    opacity: 1,
    moves: true,
  },
  running: {
    label: "Working",
    kicker: "In progress",
    line: "#56aee0",
    ink: "#2f6d99",
    fill: "#ffffff",
    border: "#56aee0",
    borderWidth: 2,
    opacity: 1,
    moves: true,
  },
  needsYou: {
    label: "Waiting on you",
    kicker: "Waiting on you",
    line: "#d8a21a",
    ink: "#8a6a08",
    fill: "#fdf8ec",
    border: "#d8a21a",
    borderWidth: 2,
    opacity: 1,
    moves: true,
  },
  done: {
    label: "Done",
    kicker: "Finished",
    line: "#2f8f5f",
    ink: "#2f6b48",
    fill: "#ffffff",
    border: "#cfe6d8",
    borderWidth: 2,
    opacity: 1,
    moves: false,
  },
  failed: {
    label: "Failed",
    kicker: "Failed",
    line: "#ec3013",
    ink: "#ae1800",
    fill: "#fff6f4",
    border: "#ffc4b8",
    borderWidth: 2,
    opacity: 1,
    moves: false,
  },
  unknown: {
    label: "Unknown",
    kicker: "Not known",
    line: "#8a8584",
    ink: "#605d5d",
    fill: "#f5f3f3",
    border: "#d7d3d3",
    borderWidth: 2,
    opacity: 1,
    moves: false,
  },
};

/** How an edge is drawn, given the states at each end. */
export type EdgeTone = "seen" | "live" | "idle";

export const EDGE_TONE: Record<EdgeTone, { stroke: string; width: number; dash?: string }> = {
  seen: { stroke: "#2f8f5f", width: 2.5 },
  live: { stroke: "#56aee0", width: 2.5, dash: "8 6" },
  idle: { stroke: "#bab6b6", width: 1.75 },
};
