/**
 * Deciding when a step transition is worth interrupting someone for.
 *
 * A notification is the one thing Anthill does that reaches past its own
 * window, so the bar is higher than it is for drawing a card. Everything below
 * is about refusing: this module's job is mostly to say no, and it is kept pure
 * and apart from delivery so the refusals can be read and tested on their own.
 *
 * Four questions, in order, and a no to any of them is the end of it:
 *
 * 1. **Is Anthill sure this is the right session?** Only a run it has actually
 *    matched, and is still claiming to watch, may speak. A run still waiting
 *    for a session to appear, one whose marker two sessions carry, and one
 *    that has been closed or given up on have all failed to earn it.
 * 2. **Did the session say this, just now?** Only events the journal accepted
 *    as new. A record re-read from the start — which happens whenever a lost
 *    run is picked back up — replays every marker it ever held, and none of
 *    them is news.
 * 3. **Is it a step Anthill can name?** The marker carries an id, and an id is
 *    not something to put in a notification. The run carries the steps the
 *    prompt named; an id that is not among them is a step Anthill does not
 *    know, and guessing at it would be the notification making something up.
 * 4. **Is it a different step from the last one announced?** Sessions repeat
 *    themselves — a step re-announced after a tool call, a loop coming back
 *    round to a step already reported. Only a change is a transition.
 *
 * Completion and failure are deliberately not notified here. They are a
 * different claim with different evidence behind them, and the issue asks for
 * step transitions; folding them in would mean a notification whose wording
 * could outrun what Anthill actually knows.
 */

import type { ObservationEvent, PendingRun } from "@anthill/live";

export type StepNotice = {
  runId: string;
  /** The block the session announced. Carried so the caller can record it. */
  stepId: string;
  title: string;
  body: string;
};

/**
 * The last step each run was announced as reaching.
 *
 * Held by the caller across polls rather than derived from the journal: the
 * question is not "what is the newest marker on record" but "what has already
 * been said out loud", and those differ the moment the app is restarted with a
 * run still going. On a restart this map starts empty, so the next genuine
 * transition notifies and the steps that happened while the app was closed do
 * not arrive in a burst.
 */
export type AnnouncedSteps = Map<string, string>;

/**
 * Whether a run is matched well enough to speak for.
 *
 * `detected_live` only, and that is the whole test: it is the one state in
 * which Anthill is claiming this run is live and that it knows which session is
 * the author's. `ambiguous_match` is the case this exists to exclude — two
 * sessions carry the marker, and a notification naming a step would be picking
 * one of them silently.
 *
 * Deliberately not "and it has a session id". A harness reporting through the
 * CLI carries both halves of the marker and no session id at all, and that
 * channel is the one built for announcing steps; requiring an id would refuse
 * exactly the reports that are least ambiguous.
 */
function certain(run: PendingRun): boolean {
  return run.state === "detected_live" && !run.closedAt;
}

/**
 * What to say about one transition.
 *
 * The workflow leads, because a machine may be watching more than one, and the
 * step follows as the thing that just changed. Neither is invented: both are
 * words the author wrote, read back to them.
 */
function wording(run: PendingRun, stepName: string): { title: string; body: string } {
  return {
    title: run.workflowName ? run.workflowName : "Live session",
    body: `Started: ${stepName}`,
  };
}

/**
 * The notices owed for one poll's newly recorded events, oldest first.
 *
 * `announced` is read and updated here, so a caller that takes the notices has
 * already had the bookkeeping done — and a caller that drops them (the setting
 * is off) still has it done, which is what stops a burst of catching-up
 * notifications the moment the setting is turned back on. Being told about a
 * step you were not watching for is worse than not being told.
 */
export function noticesFor(
  run: PendingRun,
  added: readonly ObservationEvent[],
  announced: AnnouncedSteps,
): StepNotice[] {
  const notices: StepNotice[] = [];
  if (!certain(run)) return notices;

  for (const event of added) {
    if (event.kind !== "step.marker") continue;
    const stepId = event.blockId;
    if (!stepId) continue;

    const step = run.steps?.find((item) => item.id === stepId);
    // An id this run cannot name is a step Anthill does not know it has.
    if (!step || step.name.trim().length === 0) continue;

    if (announced.get(run.anthillRunId) === stepId) continue;
    announced.set(run.anthillRunId, stepId);

    notices.push({ runId: run.anthillRunId, stepId, ...wording(run, step.name.trim()) });
  }

  return notices;
}

/** Drop a run's place when the run itself goes, so the map cannot grow forever. */
export function forgetAnnounced(announced: AnnouncedSteps, runId: string): void {
  announced.delete(runId);
}
