/**
 * The boundary every local observer sits behind.
 *
 * An observer reads. That is the whole contract: it may look at files the
 * user's own CLI wrote on this machine, and it may report what it saw. It may
 * not start a process, write to a workspace, change a setting, or send anything
 * anywhere. Keeping that in an interface rather than a comment is what stops
 * the next capability from being added in the wrong place.
 */

import type { Evidence, MarkerCli, ObservationEvent, PendingRun } from "@anthill/live";

export type ObserverCapabilities = {
  cli: MarkerCli;
  /** Whether this machine has any local records for this CLI at all. */
  available: boolean;
  /** Where the records live, for the status detail. */
  root: string;
  /** Plain-language note about what this CLI does and does not expose. */
  note: string;
  /** Whether the CLI records a real finish, as opposed to just going quiet. */
  reportsCompletion: boolean;
  /** Whether the CLI records a failure Anthill can read. */
  reportsFailure: boolean;
};

/**
 * An event as an observer produces it.
 *
 * The run id, the sequence number and the time Anthill saw it are added by the
 * journal, so an observer cannot accidentally invent an ordering — the log is
 * the only thing allowed to say what came first.
 */
export type ObservationEventDraft = Omit<ObservationEvent, "runId" | "seq" | "recordedAt">;

export type PollResult = {
  /** What this poll says about whether the run matches a local session. */
  evidence: Evidence[];
  /** What this poll saw the session do. Appended to the journal. */
  events: ObservationEventDraft[];
};

/**
 * Whether a record belongs to this run at all.
 *
 * A CLI session can be long-lived: this repo's own Claude Code transcript holds
 * six days of unrelated work in one file. The observer has to read the whole of
 * it to find the marker, but everything written before the prompt was pasted is
 * somebody else's history — and journalling it produced a feed of three
 * thousand events from a week ago, none of which this run did.
 *
 * A minute of slack, for the same reason the file scan has it: clocks are not
 * exact, and a session can start a moment before the copy finishes.
 */
export function isThisRun(event: ObservationEventDraft, run: PendingRun): boolean {
  return Date.parse(event.at) >= Date.parse(run.createdAt) - 60_000;
}

export interface LiveSessionObserver {
  readonly cli: MarkerCli;
  detectCapabilities(): Promise<ObserverCapabilities>;
  /**
   * Look once for anything new about this run.
   *
   * Empty results mean nothing has changed, which is not the same as nothing
   * being there.
   */
  poll(run: PendingRun, now: string): Promise<PollResult>;
  /** Forget per-run reading positions once a run closes. */
  forget(runId: string): void;
}
