/**
 * How present a session feels, and what Anthill is allowed to say about it.
 *
 * The state machine in `@anthill/live` answers "what does the evidence
 * support". This table answers the different question the screen asks: how
 * loudly should that be said, and in what words. They are kept apart because
 * the honest answer to the first is often quieter than a UI would like.
 *
 * The one distinction worth the extra state: `detected_live` splits into
 * **receiving** and **quiet**. A session that has written nothing for ninety
 * seconds is still a live session — an agent running a test suite writes
 * nothing while it waits — so `quiet` keeps the live colour and keeps
 * breathing, and only adds a note saying how long the silence has run. It must
 * never be drawn like `lost` (amber, still) or `stopped` (grey, still): those
 * mean Anthill has stopped being able to tell, which is a different claim
 * entirely and a worse one.
 *
 * `perimeter` says how the chip's border behaves, and nothing else in the app
 * animates to mean "live". One breathing border is the whole vocabulary.
 */

import { CLI_LABEL, type LiveSessionState, type PendingRun } from "@anthill/live";

export type Perimeter =
  /** Events are arriving. Border breathes. */
  | "travel"
  /** Live but silent. Border breathes, and the note says for how long. */
  | "breathe"
  /** Settled or unreadable. Border is plain and does not move. */
  | "still"
  /** Anthill is not watching at all. */
  | "none";

export type PresenceStyle = {
  /** The chip's own words. Carries the CLI name when one is known. */
  label: string;
  /**
   * The half-sentence the canvas plaque adds. Empty for `receiving`: a
   * confirmed session that is actively writing needs no explaining.
   */
  note: string;
  tone: string;
  /** Ink for the note, chosen to read on white rather than on the tone. */
  noteInk: string;
  perimeter: Perimeter;
  /** Whether the dot is filled, hollow, or pulsing. */
  dot: "pulse" | "solid" | "hollow";
};

/** Silence past this is worth saying out loud, but is not yet doubt. */
export const QUIET_AFTER_MS = 90_000;

/**
 * The presence key, which is the run state plus the receiving/quiet split.
 *
 * `ambiguous` is not in the design handoff's seven, which describes the states
 * a single confident match moves through. It is kept because the state machine
 * can genuinely reach it — two local sessions carrying one marker — and
 * dropping it would leave that case drawn as something it is not.
 */
export type PresenceKey =
  | "receiving"
  | "quiet"
  | "pending"
  | "lost"
  | "ambiguous"
  | "completed"
  | "failed"
  /** The window ran out and no local session ever carried the marker. */
  | "not_found"
  | "stopped";

const PRESENCE: Record<PresenceKey, PresenceStyle> = {
  receiving: {
    label: "Live",
    note: "",
    tone: "#ec3013",
    noteInk: "#ae1800",
    perimeter: "travel",
    dot: "pulse",
  },
  quiet: {
    label: "Live",
    note: "quiet for a moment — the session is still there",
    tone: "#ec3013",
    noteInk: "#ae1800",
    perimeter: "breathe",
    dot: "pulse",
  },
  pending: {
    label: "Waiting for a session",
    note: "prompt copied",
    tone: "#bab6b6",
    noteInk: "#605d5d",
    perimeter: "still",
    dot: "hollow",
  },
  lost: {
    label: "Observation lost",
    note: "nothing read for a while — it may still be running",
    tone: "#d8a21a",
    noteInk: "#8a6a08",
    perimeter: "still",
    dot: "hollow",
  },
  ambiguous: {
    label: "Ambiguous session",
    note: "more than one local session carries this marker",
    tone: "#d8a21a",
    noteInk: "#8a6a08",
    perimeter: "still",
    dot: "hollow",
  },
  completed: {
    label: "Session finished",
    note: "nothing was written back into this workflow",
    tone: "#2f8f5f",
    noteInk: "#2f6b48",
    perimeter: "still",
    dot: "solid",
  },
  not_found: {
    label: "No session detected",
    note: "no local session ever carried this run's marker",
    tone: "#bab6b6",
    noteInk: "#605d5d",
    perimeter: "still",
    dot: "hollow",
  },
  failed: {
    label: "Session failed",
    note: "the workflow is unchanged",
    tone: "#ec3013",
    noteInk: "#ae1800",
    perimeter: "still",
    dot: "solid",
  },
  stopped: {
    label: "Not observing",
    note: "your session continues unchanged",
    tone: "#bab6b6",
    noteInk: "#605d5d",
    perimeter: "none",
    dot: "hollow",
  },
};

const FROM_STATE: Record<LiveSessionState, PresenceKey> = {
  idle: "stopped",
  pending_after_copy: "pending",
  detected_live: "receiving",
  observation_lost: "lost",
  ambiguous_match: "ambiguous",
  completed: "completed",
  failed: "failed",
};

/**
 * Which presence a run is in, given how long ago it last wrote something.
 *
 * The clock is passed in rather than read, so the same run renders the same
 * way in a test as it does at that moment on screen.
 */
export function presenceKey(run: PendingRun, now: number = Date.now()): PresenceKey {
  const key = FROM_STATE[run.state];
  // `failed` covers two different things, and only one of them is a failure.
  // A run whose window ran out without ever matching a session did not have a
  // session that failed — nothing was ever found, and saying otherwise blames
  // an agent for Anthill not finding it.
  if (key === "failed" && !run.detectedSessionId) return "not_found";
  if (key !== "receiving") return key;
  if (!run.lastObservedAt) return "receiving";
  return now - Date.parse(run.lastObservedAt) > QUIET_AFTER_MS ? "quiet" : "receiving";
}

/** The style for a key. */
export function presenceStyle(key: PresenceKey): PresenceStyle {
  return PRESENCE[key];
}

/**
 * The chip's full label, which names the CLI when there is one to name.
 *
 * A run still waiting for a session has a chosen CLI but no observed one, so
 * saying "Waiting for a session · Claude Code" would imply Anthill had found
 * something. The CLI is only appended once a session is actually being read.
 */
export function presenceLabel(run: PendingRun, key: PresenceKey): string {
  if (key === "pending" && run.exchange) return "Waiting for external progress";
  const style = PRESENCE[key];
  const named = key === "receiving" || key === "quiet" || key === "completed" || key === "failed";
  // `not_found` deliberately never names a CLI: there was no session to name.
  return named ? `${style.label} · ${CLI_LABEL[run.selectedCli]}` : style.label;
}

/** Whether the border and dot animate. Only a live session moves. */
export function presenceMoves(key: PresenceKey): boolean {
  const perimeter = PRESENCE[key].perimeter;
  return perimeter === "travel" || perimeter === "breathe";
}

/**
 * Whether the canvas plaque should appear at all.
 *
 * A confirmed session that is writing needs no words beyond the chip; every
 * other state is Anthill saying something about what it does or does not know,
 * and that is worth the room.
 */
export function needsPlaque(key: PresenceKey): boolean {
  return key !== "receiving";
}

/**
 * The order runs are shown in: whatever most deserves the header.
 *
 * A finished session sits above the two states that mean Anthill lost track of
 * one, because it is a result and they are the absence of one. Ranking it last
 * meant a session that ended three minutes ago lost the header to a run Anthill
 * had given up on an hour earlier, and the finished run — the only one the
 * author wanted to look at — could not be reached at all.
 */
const PRIORITY: LiveSessionState[] = [
  "detected_live",
  "ambiguous_match",
  "pending_after_copy",
  "completed",
  "observation_lost",
  "failed",
  "idle",
];

/**
 * The runs that belong to one workflow.
 *
 * The canvas speaks about the workflow open on it, so it may only speak for a
 * run started from that workflow. Without this the chip picked the most
 * interesting run in the whole store and attached it to whatever was on
 * screen: a workflow created seconds ago announced "Session finished" for
 * somebody else's run, under a plaque saying nothing was written back into
 * "this workflow" — about a workflow that run had never touched.
 *
 * A workflow with no id owns nothing. Matching one absent id against another
 * would let every run that never recorded a workflow claim every canvas.
 */
export function runsFor(runs: PendingRun[], workflowId: string | undefined): PendingRun[] {
  if (!workflowId) return [];
  return runs.filter((run) => run.workflowId === workflowId);
}

/**
 * Which run the header speaks for.
 *
 * State first — a live session outranks a waiting one — and then recency, so
 * that among equals the header reflects the prompt the user just copied rather
 * than one they copied and forgot about half an hour ago.
 */
export function mostRelevant(runs: PendingRun[]): PendingRun | undefined {
  return [...runs].sort((a, b) => {
    const byState = PRIORITY.indexOf(a.state) - PRIORITY.indexOf(b.state);
    return byState !== 0 ? byState : Date.parse(b.createdAt) - Date.parse(a.createdAt);
  })[0];
}
