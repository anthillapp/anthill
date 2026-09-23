/**
 * Deciding when something an observed session did is worth interrupting
 * someone for.
 *
 * A notification is the one thing Anthill does that reaches past its own
 * window, so the bar is higher than it is for drawing a card. Everything below
 * is about refusing: this module's job is mostly to say no, and it is kept pure
 * and apart from delivery so the refusals can be read and tested on their own.
 * Which of the notices it does produce are wanted is a preference the caller
 * reads; here every kind is produced, and each carries its `kind` so the
 * caller can keep the ones that were asked for.
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
 *    themselves — a step re-announced after a tool call. Only a change is a
 *    transition; and a change back to a step already passed is a loop, which
 *    is its own kind of news.
 *
 * The run's own endings — finished, failed, lost — are judged from the run
 * rather than from events, in `endingNotices`: they are a state Anthill
 * arrived at, not a line the session wrote (ANT-132).
 */

import type { ObservationEvent, PendingRun } from "@anthill/live";

export type NoticeKind =
  /** The session announced a step it is starting. */
  | "step-started"
  /** The session left a step: announced the next one, or said it was done. */
  | "step-finished"
  /** A step announced again — the work came back round. */
  | "loop"
  /** The CLI recorded that it is waiting for a person. */
  | "needs-you"
  /** The session finished. */
  | "finished"
  /** The record says the session failed. */
  | "failed"
  /** Anthill can no longer read the session. */
  | "observation-lost";

export type StepNotice = {
  runId: string;
  kind: NoticeKind;
  /** The block concerned, where there is one. Carried so the caller can record it. */
  stepId?: string;
  title: string;
  body: string;
};

/**
 * What has already been said out loud about one run.
 *
 * Held by the caller across polls rather than derived from the journal: the
 * question is not "what is the newest marker on record" but "what has already
 * been said", and those differ the moment the app is restarted with a run
 * still going. On a restart this starts empty, so the next genuine transition
 * notifies and the steps that happened while the app was closed do not arrive
 * in a burst.
 */
export type Announced = {
  /** The step last announced as reached, if any. */
  last?: string;
  /** How many times each step has been announced — a second time is a loop. */
  passes: Map<string, number>;
  /** The step the session was last said to be waiting at, so it is said once. */
  waitingAt?: string;
};

export type AnnouncedSteps = Map<string, Announced>;

function announcedFor(announced: AnnouncedSteps, runId: string): Announced {
  let record = announced.get(runId);
  if (!record) {
    record = { passes: new Map() };
    announced.set(runId, record);
  }
  return record;
}

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

/** The workflow leads, because a machine may be watching more than one. */
function title(run: PendingRun): string {
  return run.workflowName ? run.workflowName : "Live session";
}

/** The step's own name, or nothing if this run cannot name it. */
function stepName(run: PendingRun, stepId: string | undefined): string | undefined {
  if (!stepId) return undefined;
  const step = run.steps?.find((item) => item.id === stepId);
  const name = step?.name.trim();
  return name ? name : undefined;
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
  /**
   * The run as it was before this poll's evidence, when the caller has it.
   *
   * The events are judged against the run as it is *after* the poll, so the
   * first poll that finds a session can speak for its first step. But the
   * poll that reads the harness's "done" also ends the run, and a run that
   * has just ended is one Anthill was certain of a moment ago — the step it
   * finished on is still news, and refusing it would lose exactly the last
   * transition of every workflow.
   */
  was?: PendingRun,
): StepNotice[] {
  const notices: StepNotice[] = [];
  if (!certain(run) && !(was && certain(was))) return notices;
  const record = announcedFor(announced, run.anthillRunId);
  const runId = run.anthillRunId;

  for (const event of added) {
    if (event.kind === "step.marker") {
      const stepId = event.blockId;
      // An id this run cannot name is a step Anthill does not know it has.
      const name = stepName(run, stepId);
      if (!stepId || !name) continue;
      if (record.last === stepId) continue;

      // Leaving a step without failing is as done as Anthill can say — the
      // same rule the diagram draws by.
      const leftName = stepName(run, record.last);
      if (record.last && leftName) {
        notices.push({ runId, kind: "step-finished", stepId: record.last, title: title(run), body: `Finished: ${leftName}` });
      }

      const pass = (record.passes.get(stepId) ?? 0) + 1;
      record.passes.set(stepId, pass);
      record.last = stepId;
      record.waitingAt = undefined;
      notices.push(
        pass > 1
          ? { runId, kind: "loop", stepId, title: title(run), body: `Back to ${name} — pass ${pass}` }
          : { runId, kind: "step-started", stepId, title: title(run), body: `Started: ${name}` },
      );
      continue;
    }

    // The harness said the work is finished: the step it was on is finished
    // with it. The run's own "finished" is said separately, from its state.
    if (event.kind === "session.end" && event.channel === "anthill:report") {
      const leftName = stepName(run, record.last);
      if (record.last && leftName) {
        notices.push({ runId, kind: "step-finished", stepId: record.last, title: title(run), body: `Finished: ${leftName}` });
        record.last = undefined;
      }
      continue;
    }

    /*
      The CLI saying, in as many words, that it is waiting for a person — a
      Claude Code Notification hook, most often a permission prompt. Not a
      turn ending: Codex ends a turn whenever it stops, and the run's own
      "finished" already says that. Once per stop at a step; a session that
      asks twice at the same step is the same wait.
    */
    if (event.kind === "notification") {
      if (record.waitingAt === (record.last ?? "")) continue;
      record.waitingAt = record.last ?? "";
      const name = stepName(run, record.last);
      notices.push({
        runId,
        kind: "needs-you",
        ...(record.last ? { stepId: record.last } : {}),
        title: title(run),
        body: name ? `Waiting on you at: ${name}` : "Waiting on you",
      });
    }
  }

  return notices;
}

/**
 * The notice owed when a run's own state arrives at an ending.
 *
 * Judged from the run rather than from an event, because these are
 * conclusions Anthill drew — a recorded finish, a recorded failure, a silence
 * long enough to stop claiming the session — not lines the session wrote.
 * Only from a run that was being followed: a run that was never matched has
 * no session to have finished or lost.
 */
export function endingNotices(before: PendingRun, after: PendingRun): StepNotice[] {
  if (before.state === after.state) return [];
  if (before.state !== "detected_live") return [];
  const runId = after.anthillRunId;
  switch (after.state) {
    case "completed":
      return [{ runId, kind: "finished", title: title(after), body: "The session finished." }];
    case "failed":
      return [{
        runId,
        kind: "failed",
        title: title(after),
        body: after.statusMessage ? `Session failed: ${after.statusMessage}` : "The session failed.",
      }];
    case "observation_lost":
      return [{
        runId,
        kind: "observation-lost",
        title: title(after),
        body: "Observation lost — the session stopped writing anything Anthill can read.",
      }];
    default:
      return [];
  }
}

/** Drop a run's place when the run itself goes, so the map cannot grow forever. */
export function forgetAnnounced(announced: AnnouncedSteps, runId: string): void {
  announced.delete(runId);
}
