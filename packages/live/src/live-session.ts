/**
 * The Live Session page, folded out of the journal.
 *
 * One pure function over the append-only event log plus the pending run's own
 * state. The page holds no state of its own, so a session watched as it happens
 * and the same session rebuilt from the journal after a restart produce the
 * identical view — which is the only reason a replay is worth trusting.
 *
 * What the fold will and will not do is the whole design:
 *
 * - A block only ever becomes `running` because the agent announced that step.
 *   No amount of tool activity moves a block on its own.
 * - `needsYou` comes from the CLI's own "I am waiting for a person" record, not
 *   from a gap in activity. A quiet session is quiet, not blocked.
 * - When observation is lost or the match is ambiguous, whatever was in flight
 *   becomes `unknown` rather than staying hopefully `running`.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { nodesOnCycles, parallelPlan } from "@anthill/workflow";

import { agentsNamedBy, attribute, buildWorkflowIndex, stepForAgent, type BlockMapping, type WorkflowIndex } from "./attribution.js";
import { inRecordedOrder, projectJournal } from "./channels.js";
import { completionOf, isAnthillTool, type ObservationEvent } from "./observation-event.js";
import type { PendingRun } from "./pending-run.js";

/**
 * Codex's name for one of its agents, as `spawn_agent`, `followup_task` and
 * `send_message` write it: `sable`, `/root/sable`, or `/root` for the session.
 */
export function codexAgent(name: string): string {
  const bare = name.trim().replace(/^\/?root\/?/, "");
  return bare === "" ? "root" : bare;
}

/** How a block is drawn while a session is being observed. */
export type BlockRunState =
  /** Not reached, as far as anything Anthill can read. */
  | "queued"
  /** The agent announced this step and has not announced another. */
  | "running"
  /** The CLI recorded that it is waiting for a person. */
  | "needsYou"
  /** The agent announced a later step, or the session finished on this one. */
  | "done"
  /** The record says this step failed. */
  | "failed"
  /** It was in flight and Anthill can no longer say. */
  | "unknown";

export type BlockView = {
  state: BlockRunState;
  /** How the block came to be in this state. Always `exact` for a moved block. */
  confidence: "exact" | "unmapped";
  enteredAt?: string;
  /**
   * Wall-clock the block has been the announced step, summed over the passes
   * it has finished.
   *
   * From the agent announcing this step to it announcing another, which is the
   * only span the record actually supports. It is not a measure of effort: a
   * step that spent half its time waiting for a person is not distinguished
   * here, and a pass still in flight is not counted at all — `enteredAt` is
   * what a reader watching one now is shown against.
   */
  spentMs?: number;
  /** How many times the agent announced it. A rework loop shows more than one. */
  passes: number;
  /** A short reason, for `failed` and `needsYou`. */
  note?: string;
  /**
   * For `needsYou`, what put it there: the CLI's own record of a request for
   * a person (`asked`), or only a turn ending with nothing since (`yielded`).
   * The second is the cautious reading of a silence and says nothing about a
   * question having been put, so nothing may present it as one (ANT-158).
   */
  waitReason?: "asked" | "yielded";
};

export type AttributedEvent = ObservationEvent & { mapping: BlockMapping };

/** One pass through a step: when it began and, once it has, when it ended. */
export type BlockSpanView = { blockId: string; pass: number; startedAt: string; endedAt?: string };

/**
 * A move the workflow never drew.
 *
 * The agent announced `to` while it was in `from`, and the workflow has no
 * connection from one to the other. A rework loop the author drew is a
 * connection and does not appear here; this is the agent's own decision to
 * go back to a step, or past one, and it is a fact about the session the
 * diagram would otherwise fold into "pass 2" as though it had been planned.
 */
export type Detour = {
  from: string;
  to: string;
  /** When the agent announced `to`. */
  at: string;
  /** Which pass through `to` this move began. */
  pass: number;
};

/**
 * A step started while another was still at work, which the workflow does not
 * run beside it (ANT-300).
 *
 * The agent announced `step` while a subagent was still working for
 * `alongside`, and the workflow draws the two one after the other, not as
 * branches of one fork. Running independent work at once can be the right
 * call; it is still not the plan on the screen, and three steps of one chain
 * drawn Working together read as Anthill's own mistake. A fan-out the
 * workflow drew is not one of these.
 */
export type Overlap = {
  step: string;
  /** The step still working when `step` started. */
  alongside: string;
  /** When it became plain: the announcement, or the subagent confirming it. */
  at: string;
  /** Which pass through `step` this was. */
  pass: number;
};

export type LiveSessionView = {
  /** Keyed by block id, covering every block in the workflow. */
  blocks: Record<string, BlockView>;
  /** The block the agent last announced, if it has not since left it. */
  activeBlockId?: string;
  /**
   * Every block running now: the one the session is on, and any a subagent
   * it started is still working for (ANT-163).
   */
  activeBlockIds: string[];
  /**
   * Every pass through every step, in the order they began, with when each
   * ended. Parallel steps have overlapping spans; a span still open has no
   * end. What the per-step time and tokens are measured over.
   */
  spans: BlockSpanView[];
  /** Every move the workflow has no connection for, oldest first. */
  detours: Detour[];
  /** Every step started beside one the workflow runs apart from it, oldest first. */
  overlaps: Overlap[];
  /** Every event, oldest first, each with how it was attributed. */
  events: AttributedEvent[];
  /** Events no block could be claimed for. Shown as session-level activity. */
  unmappedCount: number;
  /**
   * When the workflow's part of the session began: the first record that is
   * not the CLI session's own opening, which can predate the paste by hours.
   */
  startedAt?: string;
  /** The latest moment anything was recorded — the latest, not the last read. */
  lastSeenAt?: string;
  /**
   * When the session said the work was over, if the last word it had was that:
   * Codex's `task_complete`, or the harness's own done. Absent for a run that
   * only went quiet, which has no end moment of its own to show.
   */
  endedAt?: string;
  /** True while nothing has been observed at all. Drives the empty state. */
  empty: boolean;
};

/**
 * Records that mean the agent handed control back.
 *
 * `notification` is the CLI saying so in as many words. `turn.end` is the CLI
 * saying it stopped — a written record that the agent yielded, which is not
 * the same thing as a gap in activity and is exactly what this fold refuses to
 * infer from silence. It used to be read by nothing: a turn that ended with a
 * question was filed in the feed as "The agent finished its turn" and the
 * diagram went on saying "Working" for as long as the window stayed open
 * (ANT-47). The longer a reader believes that, the longer the session sits
 * there waiting to be answered.
 */
/** The title the observers give Claude Code's "[Request interrupted by user]". */
const STOPPED_BY_HAND = "Stopped by hand";

/** How close to the session's own stop a subagent's must be to be that stop (ANT-241). */
export const STOP_CASCADE_MS = 5_000;

/**
 * Which subagent stops are the session's own stop reaching them.
 *
 * Codex writes `turn_aborted` into each subagent's file as well as the
 * session's, so one press of Stop reads as the session stopped by hand and
 * every subagent it had out stopped by hand too, a moment either side. Those
 * are not somebody stopping a subagent while the session went on (ANT-190):
 * the subagent was cut off with the session, and what it got through is not
 * in the record (ANT-241). The answer is a predicate over a subagent's stop.
 */
export function stoppedWithSession(events: readonly ObservationEvent[]): (event: ObservationEvent) => boolean {
  const stops = events
    .filter((event) => isStopByHand(event) && !event.parentToolUseId && event.author?.kind !== "subagent")
    .map((event) => Date.parse(event.at))
    .filter((at) => !Number.isNaN(at));
  return (event) => {
    if (!isStopByHand(event) || !(event.parentToolUseId || event.author?.kind === "subagent")) return false;
    const at = Date.parse(event.at);
    return stops.some((stop) => Math.abs(stop - at) <= STOP_CASCADE_MS);
  };
}

/** How soon after the session's own turn ends Claude Code's helper stops (ANT-242). */
export const HELPER_STOP_MS = 5_000;
/** How recently a subagent must have been heard from for a stop to be its, whatever ended before. */
const OWN_STOP_MS = 1_500;

/** A subagent's own record: work, words or an ending the call that started it names. */
function isDelegateRecord(event: ObservationEvent): boolean {
  return Boolean(event.parentToolUseId) || event.author?.kind === "subagent";
}

/** The call a Claude Code subagent makes to hand its result back to the session. */
const HANDBACK_TOOL = "SubagentHandback";

/** A subagent handing its result back, named by the call that started it. */
export function isHandback(event: ObservationEvent): boolean {
  return event.kind === "tool.start" && event.toolName === HANDBACK_TOOL && Boolean(event.parentToolUseId);
}

/**
 * Whether this session's subagents hand back explicitly.
 *
 * Claude Code's subagents end with a SubagentHandback call. One sent off on
 * its own can end its turn well before that — to wait on a command or a
 * Monitor it started — and is woken again when that fires. Read as its end,
 * the pause drew its step Done while it still worked, and a subagent stopped
 * by hand a moment later stayed Done beside a card saying it was stopped
 * (ANT-245). Where subagents hand back, only the handback ends one; a CLI
 * whose subagents never do still ends one with its turn.
 */
export function handsBack(events: readonly ObservationEvent[]): boolean {
  return events.some(isHandback);
}

/**
 * Whose end one of the hooks' SubagentStop records is.
 *
 * - `helper`: no subagent the session started. Claude Code's own helper,
 *   which it runs under the session's id after a turn ends and after a Stop.
 * - `{ call }`: the subagent the call with this id started, named by the
 *   record itself.
 * - `unidentified`: a subagent's, but the record does not say which.
 */
export type SubagentStopReading = "helper" | "unidentified" | { call: string };

/**
 * Read each of the hooks' SubagentStop records for whose end it is.
 *
 * Claude Code's SubagentStop input names the agent that stopped — `agent_id`,
 * which is also the id in the subagent's own transcript name and on every row
 * of it. Anthill's hook used to drop it, so every stop named no subagent, and
 * whose it was had to be worked out from timing (ANT-242); timing drew the
 * helper's stop as a writer finishing whenever the writer happened to make a
 * call a moment before (ANT-245). Now the record says. A stop whose agent is
 * one of the subagents this session's transcripts were read for is that
 * subagent's, exactly; one whose agent is none of them is not a subagent the
 * session started, and settles nothing.
 *
 * Records written without an agent id — by an older hook, or for a session
 * whose delegates' transcripts carry no ids — fall back to timing. After the
 * session's turn ends, and after a Stop, Claude Code's helper ends a second or
 * two later; a subagent's own stop comes a moment after its last reply. So a
 * stop within `HELPER_STOP_MS` of the session yielding is the helper's unless
 * a subagent was heard from since, and a subagent last heard making a call is
 * not one that could have stopped: a call's result goes back to the model, and
 * the reply to it comes first (ANT-245).
 */
export function subagentStops(events: readonly ObservationEvent[]): (event: ObservationEvent) => SubagentStopReading | undefined {
  const time = (event: ObservationEvent) => Date.parse(event.at);
  const ordered = inRecordedOrder(events);
  /** Every agent id a delegate's transcript gave, and the call that started it when it said. */
  const callOf = new Map<string, string | undefined>();
  for (const event of ordered) {
    if (!event.agentId || event.kind === "subagent.end" || event.channel.endsWith(":hook")) continue;
    if (event.parentToolUseId) callOf.set(event.agentId, event.parentToolUseId);
    else if (!callOf.has(event.agentId)) callOf.set(event.agentId, undefined);
  }
  const yields = ordered
    .filter((event) => (event.kind === "turn.end" || isStopByHand(event)) && !isDelegateRecord(event))
    .map(time)
    .filter((at) => !Number.isNaN(at));
  /** Each subagent's records, oldest first, as when and whether it was a call. */
  const heard = new Map<string, { at: number; calling: boolean }[]>();
  for (const event of ordered) {
    if (!isDelegateRecord(event)) continue;
    const at = time(event);
    if (Number.isNaN(at)) continue;
    const who = event.parentToolUseId ?? "subagent";
    const list = heard.get(who) ?? [];
    list.push({ at, calling: event.kind === "tool.start" || event.kind === "tool.end" });
    heard.set(who, list);
  }
  /** Whether any subagent could have stopped in this span: heard from, and not last heard calling. */
  const couldHaveStopped = (since: number, at: number) => {
    for (const list of heard.values()) {
      let last: { at: number; calling: boolean } | undefined;
      for (const record of list) {
        if (record.at > at) break;
        last = record;
      }
      if (last && last.at > since && !last.calling) return true;
    }
    return false;
  };
  return (event) => {
    if (event.kind !== "subagent.end" || event.toolUseId || isDelegateRecord(event)) return undefined;
    if (!event.channel.endsWith(":hook")) return undefined;
    if (event.agentId) {
      const call = callOf.get(event.agentId);
      if (call) return { call };
      // An agent no delegate's transcript is from, when theirs carry ids: not
      // a subagent this session started.
      if (!callOf.has(event.agentId) && callOf.size > 0) return "helper";
    }
    const at = time(event);
    if (Number.isNaN(at)) return "unidentified";
    const yielded = yields.filter((y) => y <= at && at - y <= HELPER_STOP_MS);
    if (yielded.length === 0) return "unidentified";
    const since = Math.min(Math.max(...yielded), at - OWN_STOP_MS);
    return couldHaveStopped(since, at) ? "unidentified" : "helper";
  };
}

/**
 * Which of the hooks' SubagentStop records are Claude Code's own helper, not
 * a subagent the session started (ANT-242, ANT-245). See `subagentStops`.
 */
export function helperStops(events: readonly ObservationEvent[]): (event: ObservationEvent) => boolean {
  const read = subagentStops(events);
  return (event) => read(event) === "helper";
}

/** How long after a dispatch the report of a step announced with it may land (ANT-242). */
export const LATE_REPORT_MS = 5_000;
/** How long a call with no recorded end is still taken as the command that made a report. */
const OPEN_CALL_MS = 60_000;

/**
 * The step each dispatch was started for, when the session announced it in
 * the same breath and its report landed only after the dispatch.
 *
 * A plugin-bound run reports a step through `anthill step`, and that line is
 * recorded when the CLI runs — after Claude Code has read the whole message,
 * including an Agent call that comes after the command. So the Theme
 * Writer's dispatch was read 0.7 s before its step was reported, went to the
 * Caption step still announced, and its THEMES.md Write was then drawn
 * "Confirmed · Write CAPTIONS.md" (ANT-242). The command that made the report
 * was issued before the dispatch, though, and is still running when the report
 * lands: that is the session announcing the step first. Only a report inside
 * one of the session's own calls begun before the dispatch, landing soon
 * after it, and only when one step is announced that way.
 */
function stepsAnnouncedAsDispatched(
  journal: readonly ObservationEvent[],
  index: WorkflowIndex,
): Map<string, string> {
  const time = (event: ObservationEvent) => Date.parse(event.at);
  const dispatches = journal.filter(
    (event) => event.kind === "subagent.start" && event.toolUseId && !isDelegateRecord(event),
  );
  const spawned = new Set(dispatches.map((event) => event.toolUseId as string));
  /** The session's own calls, by id: when each began and, once known, ended. */
  const calls = new Map<string, { from: number; to?: number }>();
  for (const event of journal) {
    if (event.kind !== "tool.start" && event.kind !== "tool.end") continue;
    if (!event.toolUseId || spawned.has(event.toolUseId) || isDelegateRecord(event)) continue;
    const at = time(event);
    if (Number.isNaN(at)) continue;
    const call = calls.get(event.toolUseId);
    if (event.kind === "tool.start") {
      if (!call) calls.set(event.toolUseId, { from: at });
      else call.from = Math.min(call.from, at);
    } else if (call) call.to = call.to === undefined ? at : Math.min(call.to, at);
  }
  const known = new Set(index.blocks.map((block) => block.id));
  const reports = journal.filter(
    (event) => event.kind === "step.marker" && event.channel === "anthill:report" && event.blockId && known.has(event.blockId),
  );
  const found = new Map<string, string>();
  for (const dispatch of dispatches) {
    const at = time(dispatch);
    if (Number.isNaN(at)) continue;
    const steps = new Set<string>();
    for (const report of reports) {
      const reported = time(report);
      if (Number.isNaN(reported) || reported <= at || reported - at > LATE_REPORT_MS) continue;
      // A call never seen ending counts only while it is recent: a PreToolUse
      // nothing closed is not a command still running a minute on.
      const inside = [...calls.values()].some(
        (call) =>
          call.from <= at &&
          (call.to === undefined ? at - call.from <= OPEN_CALL_MS : reported <= call.to),
      );
      if (inside) steps.add(report.blockId as string);
    }
    if (steps.size === 1) found.set(dispatch.toolUseId as string, [...steps][0]);
  }
  return found;
}

function isStopByHand(event: ObservationEvent): boolean {
  return event.kind === "notification" && event.title === STOPPED_BY_HAND;
}

function yieldsToYou(event: ObservationEvent): boolean {
  return event.kind === "notification" || event.kind === "turn.end";
}

/**
 * Records that mean the agent is going again.
 *
 * Only things that *start*. A tool's or a subagent's end is the tail of work
 * that was already in flight, and it routinely lands after the turn that
 * dispatched it ended — in the session ANT-47 was reported from, the Analyst's
 * completion arrived two seconds after the Stop record. Reading a closing
 * record as resumption would put the diagram straight back to "Working" while
 * the agent was still waiting to be answered.
 *
 * A `message` is not resumption either, for a plainer reason: the agent's last
 * words before it stops are a message, so a message is at least as likely to
 * be the thing that preceded the yield as the thing that follows it.
 */
function resumesWork(event: ObservationEvent): boolean {
  return (
    event.kind === "step.marker" ||
    event.kind === "tool.start" ||
    event.kind === "subagent.start" ||
    event.kind === "prompt.submit" ||
    event.kind === "session.start"
  );
}

/**
 * What a block has cost by the time it is left, added to what it already had.
 *
 * A loop re-enters a block, and the question a reader is asking of a finished
 * step is how long went into it — not how long its last pass took. Anything
 * the clocks cannot support (no entry recorded, an unparseable stamp, a
 * departure that reads as earlier than the arrival) leaves the total exactly
 * as it was rather than guessing at it.
 */
function spentBy(block: BlockView, leftAt: string): number | undefined {
  if (!block.enteredAt) return block.spentMs;
  const from = Date.parse(block.enteredAt);
  const to = Date.parse(leftAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return block.spentMs;
  return (block.spentMs ?? 0) + (to - from);
}

export function foldLiveSession(
  workflow: Workflow,
  run: PendingRun,
  events: readonly ObservationEvent[],
  index: WorkflowIndex = buildWorkflowIndex(workflow),
): LiveSessionView {
  const blocks: Record<string, BlockView> = {};
  for (const block of index.blocks) {
    blocks[block.id] = { state: "queued", confidence: "unmapped", passes: 0 };
  }

  let announced: string | undefined;
  /**
   * Whether the announced step was entered on a message's tag rather than a
   * step line. The step line that usually follows confirms it; it is not a
   * second pass (ANT-163).
   */
  let enteredByTag = false;
  /**
   * Every delegation, by the id of the call that started it: the step it was
   * started from, and whether it has come back.
   *
   * A foreground call is over when its result returns. A background one
   * returns a receipt at once, so it is over when the subagent itself ends
   * its turn — which only its own transcript says (ANT-163).
   */
  const delegations = new Map<
    string,
    {
      blockId: string;
      background: boolean;
      /** Started in the background, as opposed to reused once it was back (ANT-245). */
      sentOff?: boolean;
      returned: boolean;
      delegateEnded: boolean;
      /** The name the session calls the subagent by: Codex's task name (ANT-306). */
      name?: string;
      /** What the call that started it said it was for: Claude Code's description (ANT-309). */
      described?: string;
      /** It reported to the session since its task began (ANT-306). */
      reported?: boolean;
      /** Reported, and now waiting for the session to say more (ANT-306). */
      idle?: boolean;
      /** When waiting closed the step it held, so more work can take that back. */
      closedAt?: string;
    }
  >();
  /** The same, as attribution reads it: call id to step. */
  const delegatedFrom = new Map<string, string>();
  /*
    Pairing Claude Code's SubagentStop hook with the subagent it was for.

    A subagent sent off on its own is over when its transcript records the
    end of its turn — but Claude Code sometimes writes that last message
    without a stop reason, and then only the hook says it stopped, naming no
    subagent. W15's Quantity Checker was drawn "Working" for a minute after
    the session had its verdict and moved on. So the hook is paired with the
    subagent heard from last, unless a subagent whose end the transcript did
    record is still owed its hook.
  */
  const lastHeard = new Map<string, number>();
  /** Subagents whose last record was a call: mid-turn, their reply still to come (ANT-245). */
  const lastCalling = new Set<string>();
  const endedByHook = new Set<string>();
  let hooksOwed = 0;
  /** The subagents whose recorded end the owed hooks are for, when a hook names its subagent. */
  const owedBy = new Set<string>();
  /** How recently a subagent must have been heard from for a stop to be its. */
  const STOP_PAIRING_MS = 10_000;
  const spans: BlockSpanView[] = [];
  /**
   * Whether the session did any work in the announced step before it moved
   * on. A step left with none was announced in a batch — Claude Code prints
   * every parallel step's line and only then starts their subagents — and is
   * not finished yet: it waits, still running, for the session's next real
   * action to say what it was (ANT-164).
   */
  let workSinceEntered = false;
  /** Steps left with no work done, by when they were left and the move that left them. */
  const pendingClose = new Map<string, { leftAt: string; detour?: Detour }>();
  /** Steps a subagent opened that no step line has named yet (ANT-184). */
  const openedByDispatch = new Set<string>();
  /** Background commands started and not yet reported ended, by call id (ANT-308). */
  const backgroundCommands = new Set<string>();
  /**
   * Whether the hook channel wrote anything for this run.
   *
   * The hooks are what can tell "waiting on you" from "done": they write a
   * `notification` for a real wait and nothing for a turn that ended because
   * the work was over. The transcript alone cannot (ANT-78).
   */
  const hooksCarried = events.some((event) => event.channel.endsWith(":hook"));
  /** Whether the CLI said it was waiting for a person since the announced step began. */
  let askedSinceEntered = false;
  /*
    The session itself was stopped by hand on the step it is on — Claude
    Code's "[Request interrupted by user]" in the session's own record. That
    is not a question put to a person, and a run that ends there must not be
    left "Waiting on you" (ANT-204).
  */
  let stoppedHere = false;
  /**
   * The session's last word was a stop by hand, nothing started since. A run
   * a stop closes is `observation_lost`, and what it was doing is known: it
   * was stopped, not lost sight of (ANT-208).
   */
  let sessionStopped = false;
  /**
   * When the session last said the work was over, while nothing has resumed
   * since. An explicit ending settles the step it lands on without the
   * hooks' help, and a generic turn end after it cannot reopen it (ANT-158,
   * ANT-161).
   */
  let finishedAt: string | undefined;
  /**
   * Whether that ending was the harness's own `anthill done`, not the
   * session's turn record. Only another report takes it back (ANT-303).
   */
  let doneReported = false;
  let sessionOpenedAt: string | undefined;
  let startedAt: string | undefined;
  let lastSeenAt: string | undefined;
  let unmappedCount = 0;
  const attributed: AttributedEvent[] = [];
  const detours: Detour[] = [];
  const overlaps: Overlap[] = [];
  /** Every connection the workflow has, as "source→target". */
  const planned = new Set(workflow.edges.map((edge) => `${edge.source}→${edge.target}`));
  /** Which steps the workflow runs side by side: moving between them is no detour (ANT-166). */
  const parallelSteps = parallelPlan(workflow);
  /**
   * Steps a connection can lead back into (ANT-179). A parallel branch that is
   * not one of them, announced again from a sibling branch, is the session
   * coming back to report its result — the prompt asks for the line "each time
   * you come back to it" — and that is more of the same pass, not another. A
   * return from anywhere else stays a second pass: the agent going back on its
   * own is drawn as one (ANT-82).
   */
  const repeatable = nodesOnCycles(workflow);
  /*
    Where a spawn that names no step goes, when its own name names an agent
    (ANT-307). Codex spawned three authors while the session was still on
    the step before them and reported their steps only after, in one command:
    every spawn went to that earlier step, which then stayed Working beside
    them, and the authors read as started early. A spawn named after an agent
    goes to that agent's nearest step on from where the session is — the
    step itself included — and only a unique nearest one counts: the same
    agent runs its review and its revision later on too.
  */
  const forwardOut = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (edge.kind === "rework") continue;
    forwardOut.set(edge.source, [...(forwardOut.get(edge.source) ?? []), edge.target]);
  }
  const nearestFor = (spawnName: string | undefined): string | undefined => {
    if (!announced) return undefined;
    const agents = agentsNamedBy(index, spawnName);
    if (agents.size === 0) return undefined;
    const runsIt = new Set(index.blocks.filter((block) => block.agentSlug && agents.has(block.agentSlug)).map((block) => block.id));
    let frontier = [announced];
    const seen = new Set(frontier);
    while (frontier.length > 0) {
      const here = frontier.filter((id) => runsIt.has(id));
      if (here.length > 0) return here.length === 1 ? here[0] : undefined;
      const next: string[] = [];
      for (const id of frontier) {
        for (const target of forwardOut.get(id) ?? []) {
          if (seen.has(target)) continue;
          seen.add(target);
          next.push(target);
        }
      }
      frontier = next;
    }
    return undefined;
  };
  /** The Approval Gates: a person decides there, and nothing else settles one. */
  const gates = new Set(workflow.nodes.filter((node) => node.type === "approval").map((node) => node.id));

  const isOpen = (id: string) => blocks[id]?.state === "running" || blocks[id]?.state === "needsYou";
  /*
    A subagent sent off on its own is done with a step when its turn ends —
    or, Codex's long-lived subagents, when it has reported to the session and
    sits waiting for more (ANT-306): one of those lives the whole run as a
    single turn, and its turn ending held every step it worked on open.
  */
  const settled = (d: { background: boolean; returned: boolean; delegateEnded: boolean; idle?: boolean }) =>
    d.background ? d.delegateEnded || d.idle === true : d.returned;
  /** Whether a step still has a subagent working for it. */
  const outstanding = (id: string) =>
    [...delegations.values()].some((d) => d.blockId === id && !settled(d));

  /**
   * A step is under way while others are: each still held open by a subagent
   * of its own, and not drawn beside it, is an overlap (ANT-300). Only a
   * subagent's work counts as the other step going on — a step left with
   * nothing done in it is the session announcing two at once, which says
   * nothing yet about running them together.
   */
  const noteOverlaps = (id: string, at: string, pass: number) => {
    for (const other of Object.keys(blocks)) {
      if (other === id || !isOpen(other) || !outstanding(other)) continue;
      if (parallelSteps.parallel(other, id)) continue;
      if (overlaps.some((o) => o.step === id && o.pass === pass && o.alongside === other)) continue;
      overlaps.push({ step: id, alongside: other, at, pass });
    }
  };

  /** A pass ends: the step's time is added up and its span closed. */
  const finish = (id: string, at: string, state: "done" | "failed" | "unknown" = "done", note?: string) => {
    const block = blocks[id];
    if (!block || !isOpen(id)) return;
    const { note: _note, waitReason: _why, ...rest } = block;
    const spent = state === "done" ? spentBy(block, at) : block.spentMs;
    blocks[id] = {
      ...rest,
      state,
      ...(spent !== undefined ? { spentMs: spent } : {}),
      ...(note ? { note } : {}),
    };
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      if (spans[i].blockId === id && spans[i].endedAt === undefined) {
        spans[i] = { ...spans[i], endedAt: at };
        break;
      }
    }
  };

  /**
   * The session moves to another step. The one it leaves is done — unless a
   * subagent it started is still working for it, in which case it goes on
   * running until the last of them comes back (ANT-163), or unless nothing was
   * done in it at all, in which case it waits to see (ANT-164).
   */
  const leave = (id: string, at: string): "closed" | "kept" | "pending" => {
    if (!isOpen(id)) return "closed";
    if (outstanding(id) || (id === announced && !workSinceEntered)) {
      const { note: _note, waitReason: _why, ...rest } = blocks[id];
      blocks[id] = { ...rest, state: "running" };
      if (outstanding(id)) return "kept";
      pendingClose.set(id, { leftAt: at });
      return "pending";
    }
    finish(id, at);
    return "closed";
  };

  /**
   * A step left with no work done turns out to have been finished after all:
   * closed as of the moment it was left, and the move that left it counted.
   */
  /** Steps whose last pass was closed with nothing done in it. */
  const closedEmpty = new Set<string>();

  /*
    The step of the agent a subagent is named after, among the steps the
    session announced together and has not worked in yet (ANT-309). Claude
    Code announced four authors' steps in one second and only then started
    their subagents, untagged and all `general-purpose`, each described as
    "<Author> drafts …". Every author has later steps too, so the agent alone
    names none, and the nearest one on from the last announced step is never
    a sibling: three were drawn Done after 300 ms and all the work went to the
    fourth. Only a single match counts.
  */
  const announcedTogetherFor = (name: string | undefined): string | undefined => {
    const on = announced;
    if (!name || !on) return undefined;
    // The batch: the step the session is on and those the plan runs beside
    // it, announced with it and not worked in yet. A step announced just
    // before the fork, and closed empty by it, is not one of them.
    const batch = index.blocks.filter(
      (block) =>
        block.agentSlug !== undefined &&
        (block.id === on ||
          ((pendingClose.has(block.id) || closedEmpty.has(block.id)) && parallelSteps.parallel(block.id, on))),
    );
    // Named first, as an agent is: "Corin drafts three architectures".
    const agents = agentsNamedBy(index, name);
    const first = batch.filter((block) => agents.has(block.agentSlug as string));
    if (first.length > 0) return first.length === 1 ? first[0].id : undefined;
    // Or named anywhere, when only one agent of the batch is: "Council
    // member Wren assesses all". Two named — "Arden reviews Corin" — is none.
    const words = new Set(name.toLowerCase().split(/[^a-z0-9]+/));
    const anywhere = batch.filter((block) => {
      const own = (block.agentSlug as string).split("-")[0];
      const id = block.agentId?.toLowerCase();
      return words.has(own) || (id !== undefined && words.has(id));
    });
    return anywhere.length === 1 ? anywhere[0].id : undefined;
  };

  /*
    Tool calls that failed in a step's current pass and were not made to work
    after: by step, the tools whose last call there failed. A step whose Write
    was refused, and the file never written, was settled Done when the run
    went quiet — the refusal was on the page in red, and the session never said
    the work was done (ANT-220).
  */
  const failedIn = new Map<string, Set<string>>();
  const toolNames = new Map<string, string>();
  const UNFINISHED_NOTE = (tool: string) =>
    `A ${tool} call in this step failed and was never made to work, and the session ended without saying the work was done.`;

  const closePending = (id: string) => {
    const pending = pendingClose.get(id);
    if (!pending) return;
    pendingClose.delete(id);
    finish(id, pending.leftAt);
    closedEmpty.add(id);
    if (pending.detour) detours.push(pending.detour);
  };

  const enter = (id: string, at: string, viaTag: boolean) => {
    closedEmpty.delete(id);
    failedIn.delete(id);
    // Back to a step left with nothing done in it: it never ended, so this is
    // the same pass going on, not another (ANT-166 — "A, B" in one command,
    // then "A" again to start on it).
    if (pendingClose.has(id) && announced !== id) {
      pendingClose.delete(id);
      const left = announced ? leave(announced, at) : "closed";
      void left;
      announced = id;
      enteredByTag = viaTag;
      workSinceEntered = false;
      askedSinceEntered = false;
      stoppedHere = false;
      finishedAt = undefined;
      return;
    }
    const fanOut = announced !== undefined && announced !== id && outstanding(announced);
    const left = announced && announced !== id ? leave(announced, at) : "closed";
    // Steps announced beside the one left, never started: the session going
    // on to a step the plan runs after them means they are over (ANT-309).
    for (const other of [...pendingClose.keys()]) {
      if (other !== id && other !== announced && !parallelSteps.parallel(other, id)) closePending(other);
    }
    /*
      A step its subagent opened before its line was read: this is the line
      for that same pass. Claude Code starts the subagent in the same message
      as the command that prints the line, and the line is recorded only when
      the command returns — seconds after the subagent began (ANT-184).
    */
    const continuing = openedByDispatch.delete(id) && isOpen(id);
    let pass: number;
    if (continuing) {
      pass = blocks[id].passes;
    } else {
      // Coming back to a step still open ends the pass it was on — as of when
      // it was left, if it was left with nothing done.
      if (pendingClose.has(id)) closePending(id);
      if (isOpen(id)) finish(id, at);
      const entering = blocks[id];
      const again =
        (entering?.passes ?? 0) >= 1 &&
        !repeatable.has(id) &&
        announced !== undefined &&
        announced !== id &&
        parallelSteps.parallel(announced, id);
      pass = (entering?.passes ?? 0) + (again ? 0 : 1);
      blocks[id] = {
        state: "running",
        confidence: "exact",
        enteredAt: at,
        // Carried, not reset: what earlier passes cost is still part of what
        // this step has cost.
        ...(entering?.spentMs !== undefined ? { spentMs: entering.spentMs } : {}),
        passes: pass,
      };
      spans.push({ blockId: id, pass, startedAt: at });
    }
    noteOverlaps(id, at, pass);
    // Only a move between two steps can be one the plan lacks: the first
    // step came from nowhere the fold can see, a step announced again is not
    // a move at all, and a step started while the last one's subagents are
    // still at work is the session fanning out, not leaving it.
    if (
      announced &&
      announced !== id &&
      !fanOut &&
      !planned.has(`${announced}→${id}`) &&
      !parallelSteps.parallel(announced, id)
    ) {
      const detour = { from: announced, to: id, at, pass };
      // A step left with nothing done may yet turn out to be a fan-out; the
      // move counts only if it is closed after all.
      const pending = left === "pending" ? pendingClose.get(announced) : undefined;
      if (pending) pending.detour = detour;
      else detours.push(detour);
    }
    announced = id;
    enteredByTag = viaTag;
    doneReported = false;
    // A subagent already at work for the step is work in it.
    workSinceEntered = continuing;
    askedSinceEntered = false;
    stoppedHere = false;
    finishedAt = undefined;
  };

  /** Take back the finish of a step's last pass: it had not ended after all. */
  const reopen = (id: string) => {
    const block = blocks[id];
    const index = spans.map((span) => span.blockId).lastIndexOf(id);
    const span = index >= 0 ? spans[index] : undefined;
    if (!block || !span?.endedAt || !block.enteredAt) return;
    const counted = Date.parse(span.endedAt) - Date.parse(block.enteredAt);
    // Open again, so no longer a step closed with nothing done (ANT-309).
    closedEmpty.delete(id);
    // The move that closed this pass was not a move away after all, so it is
    // not a detour either.
    for (let i = detours.length - 1; i >= 0; i -= 1) {
      if (detours[i].from === id && detours[i].at === span.endedAt) detours.splice(i, 1);
    }
    const { endedAt: _ended, ...open } = span;
    spans[index] = open;
    const spentMs =
      block.spentMs !== undefined && !Number.isNaN(counted) ? block.spentMs - counted : block.spentMs;
    blocks[id] = {
      ...block,
      state: "running",
      ...(spentMs !== undefined && spentMs > 0 ? { spentMs } : {}),
    };
    if (spentMs !== undefined && spentMs <= 0) delete blocks[id].spentMs;
  };

  /**
   * Steps a subagent working for them was stopped by hand, before it handed
   * back: they end failed, not done (ANT-190).
   */
  const stoppedFor = new Set<string>();
  /**
   * Steps a subagent working for them was cut off from by the session's own
   * stop, before it handed back: unknown, like one still out when the session
   * ended (ANT-241).
   */
  const cutOffFor = new Set<string>();
  const cutOffWithSession = stoppedWithSession(events);
  const stopOf = subagentStops(events);
  /** The delegations whose subagent has handed back since it was last at work. */
  const handedBack = new Set<string>();
  const explicitHandback = handsBack(events);
  /**
   * Whether a subagent's turn ending, or its SubagentStop, is its end. One in
   * the foreground ends when its call returns, whatever its turn did; one
   * started in the background, in a session whose subagents hand back, only
   * once it has (ANT-245). One reused after it was back is left as it was:
   * its replies have been seen to end without a handback.
   */
  const canEnd = (call: string) =>
    !explicitHandback || !delegations.get(call)?.sentOff || handedBack.has(call);
  const STOPPED_NOTE = "A subagent working on this step was stopped by hand before it handed back.";
  const STOPPED_HERE_NOTE = "The session was stopped by hand on this step.";

  /*
    A session that ended with a subagent still out on a step: killed, or
    closed while the delegate worked. The subagent never handed back, so the
    step is not done — it was drawn green and counted as finished (W9 in the
    0.8.3 QA, interrupted right after it delegated). Nor is it a failure
    anything recorded. What the delegate got through is not in the record,
    and the step says so.
  */
  const CUT_OFF_NOTE =
    "The session ended while a subagent was still working on this step, and the subagent never handed back.";

  /*
    A step handed to a subagent while a sibling the workflow runs beside it
    was handed to another: the session fanned out, and is waiting on them
    rather than working in either (ANT-309). The last of the batch is still
    the step the session announced last, and its subagent coming back left it
    Working: Ione drawn at work for minutes after the session said Ione was
    done, while Corin, announced before it, went green.
  */
  const fannedOut = (id: string) => {
    const all = [...delegations.values()];
    return all.some((d) => d.blockId === id) && all.some((d) => d.blockId !== id && parallelSteps.parallel(d.blockId, id));
  };

  /** A delegation came back: its step is done if nothing else holds it open. */
  const release = (id: string, at: string) => {
    if ((id !== announced || fannedOut(id)) && isOpen(id) && !outstanding(id)) {
      if (stoppedFor.has(id)) finish(id, at, "failed", STOPPED_NOTE);
      else if (cutOffFor.has(id)) finish(id, at, "unknown", CUT_OFF_NOTE);
      else finish(id, at);
    }
  };

  // One action, however many channels wrote it down. A session with hooks
  // installed is described twice over, and everything below counts what it
  // iterates: the same step announced once arrived twice and was drawn as a
  // second pass through the block (ANT-48).
  // And in the order it happened rather than the order it was read (ANT-159).
  const journal = projectJournal(events);
  /*
    Calls that are not work in any step: the commands that printed step lines,
    and the calls that started subagents (their receipts included). Known from
    the whole journal up front, because a command's call is recorded before
    the line it printed (ANT-164).
  */
  const plumbing = new Set<string>();
  /*
    The step each subagent says it is working on, by the call that started
    it: the tag on the first of its own messages that carries one. Codex
    encrypts what a spawn hands over, so its subagent.start names no step,
    and three checks announced together and then spawned together all went to
    the last one announced — two drawn "Done · took 0ms", the third with all
    three's work (ANT-203). Each subagent's thread names its step itself.
    Known up front, like `plumbing`, because the spawn is read first.
  */
  const saysItWorksOn = new Map<string, string>();
  for (const event of journal) {
    if (event.printedBy) plumbing.add(event.printedBy);
    if (event.kind === "subagent.start" && event.toolUseId) plumbing.add(event.toolUseId);
    // Calls to Anthill's own tools: the session reading or reporting on the
    // run, not working in it (ANT-215).
    if ((event.kind === "tool.start" || event.kind === "tool.end") && event.toolUseId && isAnthillTool(event.toolName)) {
      plumbing.add(event.toolUseId);
    }
    if (
      event.kind === "message" &&
      event.parentToolUseId &&
      event.stepTag &&
      !saysItWorksOn.has(event.parentToolUseId)
    ) {
      saysItWorksOn.set(event.parentToolUseId, event.stepTag);
    }
  }
  const announcedAsDispatched = stepsAnnouncedAsDispatched(journal, index);
  for (const event of journal) {
    // A command sent to run in the background is at work until its own
    // notification says it ended (ANT-308). That end is only bookkeeping: it
    // is not the session doing anything, so it goes no further.
    if (event.kind === "tool.start" && event.background && event.toolUseId && !delegations.has(event.toolUseId)) {
      backgroundCommands.add(event.toolUseId);
    }
    if (event.kind === "task.end") {
      if (event.toolUseId) backgroundCommands.delete(event.toolUseId);
      continue;
    }
    /*
      A subagent that had handed back, at work again: the session reused it —
      Claude Code's SendMessage, Codex's send_message — and what it does now is
      for the step the session is on, not the one it was first started for.
      Its Fix-stage edits were filed under Implement, and the step it was
      reused for never waited on it (ANT-218).
    */
    const reused = event.parentToolUseId ? delegations.get(event.parentToolUseId) : undefined;
    // A tool call, not a message: an agent's closing words and the end of its
    // turn are one record, stamped alike, and may be read in either order.
    if (reused && reused.delegateEnded && event.kind === "tool.start") {
      reused.delegateEnded = false;
      reused.returned = false;
      // Its call returned long ago and will not again: reused, it runs on its
      // own, and the end of its turn is its end.
      reused.background = true;
      // Its next ending is a new one, to be paired with its own hook.
      endedByHook.delete(event.parentToolUseId as string);
      // And it has to hand back again before that ending counts.
      handedBack.delete(event.parentToolUseId as string);
      // Its agent's step among those just announced together, when the
      // session woke several authors for steps it announced at once — not
      // just the last one it announced (ANT-309).
      const own = announcedTogetherFor(reused.name) ?? announcedTogetherFor(reused.described);
      const to = own && blocks[own] ? own : announced;
      if (to && blocks[to] && reused.blockId !== to) {
        reused.blockId = to;
        delegatedFrom.set(event.parentToolUseId as string, to);
        if (to !== announced) {
          pendingClose.delete(to);
          if (blocks[to].state === "done" && closedEmpty.has(to)) reopen(to);
        }
      }
      // The session's turn ending before the reused agent began was the
      // session waiting for it, not for a person.
      const step = blocks[reused.blockId];
      if (step?.state === "needsYou" && step.waitReason === "yielded" && !finishedAt && !stoppedHere) {
        const { note: _note, waitReason: _why, ...rest } = step;
        blocks[reused.blockId] = { ...rest, state: "running" };
      }
    }
    const mapping = attribute(event, index, announced, delegatedFrom);
    attributed.push({ ...event, mapping });
    // Anthill's own notes — the session it found, a session that wrote
    // nothing — are shown in the feed and are nothing the session did. Read
    // as a request for a person, the note that a VS Code chat was found,
    // which can land after the done line, left the last step waiting on you.
    if (event.source === "anthill" && event.kind === "notification") continue;
    if (event.kind === "tool.start" && event.toolUseId && event.toolName) toolNames.set(event.toolUseId, event.toolName);
    if (event.kind === "tool.end" && event.toolUseId && mapping.blockId && event.ok !== undefined) {
      const tool = event.toolName ?? toolNames.get(event.toolUseId);
      if (tool && !isAnthillTool(tool)) {
        const failed = failedIn.get(mapping.blockId) ?? new Set<string>();
        if (event.ok === false) failed.add(tool);
        else failed.delete(tool);
        failedIn.set(mapping.blockId, failed);
      }
    }
    // Usage is bookkeeping, not activity; counting it against "events not
    // mapped to a step" would make every quiet turn look like a mystery.
    if (mapping.confidence === "unmapped" && event.kind !== "usage") unmappedCount += 1;

    if (event.kind === "session.start") sessionOpenedAt ??= event.at;
    else startedAt ??= event.at;
    if (!lastSeenAt || Date.parse(event.at) > Date.parse(lastSeenAt)) lastSeenAt = event.at;

    /*
      Whose record this is. A subagent's work reaches the step it was started
      from and settles that delegation, and nothing else: its turn ending is
      not the session waiting for a person, and its tool calls are not the
      session going on (ANT-161, ANT-163).
    */
    // A record naming the call that started it is a subagent's, even before
    // that call has been read: Claude Code writes the message holding the
    // Agent calls only once the last is made, and the subagents are already
    // at work by then (ANT-164).
    // Claude Code's own helper stopping after the session's turn is nobody's
    // end (ANT-242). A stop that names its subagent is that one's (ANT-245).
    const stop = event.kind === "subagent.end" && !event.parentToolUseId && event.channel.endsWith(":hook")
      ? stopOf(event)
      : undefined;
    if (stop && typeof stop === "object") {
      const d = delegations.get(stop.call);
      // A subagent that has not handed back stopped only to wait (ANT-245).
      if (d && !d.delegateEnded && canEnd(stop.call)) {
        endedByHook.add(stop.call);
        d.delegateEnded = true;
        release(d.blockId, event.at);
      } else if (d && owedBy.delete(stop.call) && hooksOwed > 0) {
        // The hook its transcript's end was already counted for.
        hooksOwed -= 1;
      }
    } else if (stop === "unidentified") {
      if (hooksOwed > 0) {
        hooksOwed -= 1;
      } else {
        const at = Date.parse(event.at);
        let best: string | undefined;
        for (const [call, heard] of lastHeard) {
          const d = delegations.get(call);
          if (!d || d.delegateEnded || !canEnd(call) || Number.isNaN(at) || heard > at || at - heard > STOP_PAIRING_MS) continue;
          // Last heard making a call: its reply comes before it can stop.
          if (lastCalling.has(call)) continue;
          if (best === undefined || heard > (lastHeard.get(best) ?? 0)) best = call;
        }
        const d = best ? delegations.get(best) : undefined;
        if (best && d) {
          endedByHook.add(best);
          d.delegateEnded = true;
          release(d.blockId, event.at);
        }
      }
    }

    const via = event.parentToolUseId ? delegations.get(event.parentToolUseId) : undefined;
    if (via && event.parentToolUseId) {
      const at = Date.parse(event.at);
      if (!Number.isNaN(at)) lastHeard.set(event.parentToolUseId, at);
      if (event.kind === "tool.start" || event.kind === "tool.end") lastCalling.add(event.parentToolUseId);
      else lastCalling.delete(event.parentToolUseId);
    }
    if (via || event.parentToolUseId || event.author?.kind === "subagent") {
      // Its result handed back: a subagent sent off on its own is done here,
      // whatever its turn does next (ANT-245).
      if (via && event.parentToolUseId && isHandback(event)) {
        handedBack.add(event.parentToolUseId);
        if (via.background && !via.delegateEnded) {
          via.delegateEnded = true;
          release(via.blockId, event.at);
        }
      }
      /*
        Codex's long-lived subagents (ANT-306) never end a turn between tasks.
        One reports to the session (send_message to root) and then waits
        (wait_agent): that is the task handed back, and the step it held is
        over. Work after that — not more messages or waiting — is the same
        task going on after all: the step is taken back until it waits again.
      */
      if (via && event.cli === "codex" && event.kind === "tool.start") {
        if (event.toolName === "send_message" && event.to === "root") via.reported = true;
        else if (event.toolName === "wait_agent") {
          if (via.reported && !via.idle) {
            via.idle = true;
            const open = isOpen(via.blockId);
            release(via.blockId, event.at);
            if (open && !isOpen(via.blockId)) via.closedAt = event.at;
          }
        } else if (event.toolName !== "send_message" && event.toolName !== "list_agents" && via.idle) {
          via.idle = false;
          if (via.closedAt && blocks[via.blockId]?.state === "done") reopen(via.blockId);
          delete via.closedAt;
        }
      }
      if (via && event.kind === "turn.end" && canEnd(event.parentToolUseId ?? "")) {
        if (!via.delegateEnded && !endedByHook.has(event.parentToolUseId ?? "")) {
          hooksOwed += 1;
          owedBy.add(event.parentToolUseId ?? "");
        }
        via.delegateEnded = true;
        release(via.blockId, event.at);
      }
      // Stopped by the person: over, and not finished (ANT-190).
      // Unless it is the session's own stop reaching it: cut off, not
      // stopped on its own (ANT-241).
      if (via && event.kind === "notification" && event.title === STOPPED_BY_HAND) {
        via.delegateEnded = true;
        via.returned = true;
        (cutOffWithSession(event) ? cutOffFor : stoppedFor).add(via.blockId);
        release(via.blockId, event.at);
      }
      continue;
    }

    /*
      The session giving one of Codex's long-lived subagents its next task
      (ANT-306). The subagent now works for the step the session is on, and
      the step it worked for before is over: it was held open for as long as
      the subagent lived, which is the whole run, while the work it was given
      for had long been reported.
    */
    if (event.cli === "codex" && event.kind === "tool.start" && event.toolName === "followup_task" && event.to) {
      const name = event.to;
      const call = [...delegations.entries()].reverse().find(([, d]) => d.name === name)?.[0];
      const d = call ? delegations.get(call) : undefined;
      if (call && d && announced && blocks[announced]) {
        const from = d.blockId;
        d.blockId = announced;
        delegatedFrom.set(call, announced);
        d.background = true;
        d.delegateEnded = false;
        d.idle = false;
        d.reported = false;
        delete d.closedAt;
        handedBack.delete(call);
        if (from !== announced) release(from, event.at);
      }
    }

    // The session's own work. It is what tells a step left with nothing done
    // apart from a finished one: work elsewhere means those steps are over.
    //
    // Only what the transcript records counts. A hook alone cannot tell the
    // session's own call from a subagent's, or the call that starts a
    // subagent from any other — and it arrives first: Claude Code writes the
    // message holding the Agent calls only once the last of them is made, so
    // for seconds the hook for starting A's subagent looked like work
    // elsewhere and closed A, with a detour, until the transcript caught up.
    const hookOnly = event.channel.endsWith(":hook") && !(event.alsoFrom ?? []).some((c) => !c.endsWith(":hook"));
    if (
      (event.kind === "tool.start" || event.kind === "tool.end") &&
      !hookOnly &&
      !(event.toolUseId && plumbing.has(event.toolUseId))
    ) {
      workSinceEntered = true;
      for (const id of [...pendingClose.keys()]) {
        // A step the plan runs beside the one the session is on is not over
        // because the session works: announced with it, it waits for its own
        // subagent. Three rework steps went Done the moment the session wrote
        // its notes, before it woke their authors (ANT-309).
        if (announced && id !== announced && parallelSteps.parallel(id, announced)) continue;
        closePending(id);
      }
    }
    // Starting a subagent, or saying something, is work in the step too — a
    // step done in words alone was done — but neither closes a batch-announced
    // step: the first is how such a step goes on, the second says nothing
    // about where the session is.
    if (event.kind === "subagent.start" || event.kind === "message") workSinceEntered = true;

    // Only a step line moves the graph. A tag and a subagent's work say which
    // step something belongs to; they are not the agent saying where it is.
    if (event.kind === "step.marker" && mapping.confidence === "exact" && mapping.blockId) {
      // The harness reporting, after its done, the step it finished on: the
      // work was not over after all, and this is the step's next pass (ANT-303).
      const reportedAgain = doneReported && event.channel === "anthill:report";
      if (mapping.blockId === announced && !enteredByTag && !reportedAgain) {
        // The step the session is already on, said again — a Stop hook reads
        // the same line out of the last message long after the command that
        // printed it. Coming back to a step means coming from another one;
        // this is not another pass (ANT-164).
        continue;
      }
      if (mapping.blockId === announced && enteredByTag) {
        // The line confirming a step its messages had already named. It is
        // where the step properly begins: what was done under the tag before
        // it — setting up, as often as not — is not work in the step (ANT-164).
        enteredByTag = false;
        workSinceEntered = false;
      } else {
        enter(mapping.blockId, event.at, false);
      }
      continue;
    }

    // A message naming a step nothing has announced: the fallback for a step
    // line the agent forgot. A step already begun or finished is only named.
    if (
      event.kind === "message" &&
      event.stepTag &&
      mapping.blockId === event.stepTag &&
      blocks[event.stepTag]?.state === "queued"
    ) {
      enter(event.stepTag, event.at, true);
      continue;
    }

    /*
      A subagent started for a step: the one its call names, when the session
      put the step's tag in what it handed over, else the one the subagent's
      own messages name (ANT-203), else the step the session is on. The
      call's own word comes first because the session can announce
      several steps and only then start their subagents together — measured,
      that is exactly how Claude Code fans out, and by the moment of dispatch
      every subagent looked like the last-announced step's (ANT-163).
    */
    if (event.kind === "subagent.start" && event.toolUseId) {
      const own = saysItWorksOn.get(event.toolUseId);
      // The agent it runs, when exactly one step has that agent (ANT-217).
      const named = stepForAgent(index, event.agentName) ?? stepForAgent(index, event.detail, true);
      const late = announcedAsDispatched.get(event.toolUseId);
      // Its agent's step among those just announced together (ANT-309).
      const together =
        !event.stepTag && !own && !named && !late
          ? (announcedTogetherFor(event.agentName) ?? announcedTogetherFor(event.detail))
          : undefined;
      // The nearest step on whose agent the spawn is named after: Codex
      // starts a step's subagent before it reports the step (ANT-307).
      const near = !event.stepTag && !own && !named && !late && !together ? nearestFor(event.agentName) : undefined;
      const target =
        event.stepTag && blocks[event.stepTag]
          ? event.stepTag
          : own && blocks[own]
            ? own
            : named && blocks[named]
              ? named
              : late && blocks[late]
                ? late
                : together && blocks[together]
                  ? together
                  : near && blocks[near]
                    ? near
                    : announced;
      if (target && blocks[target]) {
        // The dispatch card belongs where its subagent's work goes.
        const card = attributed[attributed.length - 1];
        if (card?.toolUseId === event.toolUseId && card.mapping.blockId !== target) {
          card.mapping =
            target === named && !event.stepTag && !own
              ? { blockId: target, confidence: "likely", how: "the agent this subagent runs belongs to this step" }
              : target === late && !event.stepTag && !own
                ? { blockId: target, confidence: "likely", how: "the session announced this step as it started this subagent" }
                : target === together && together !== announced
                  ? { blockId: target, confidence: "likely", how: "the step of the agent this subagent is named after, announced with its siblings" }
                : target === near && near !== announced
                  ? { blockId: target, confidence: "likely", how: "the next step of the agent this subagent is named after" }
                : { blockId: target, confidence: "exact", how: "a subagent started for this step" };
        }
        delegations.set(event.toolUseId, {
          blockId: target,
          background: event.background === true,
          sentOff: event.background === true,
          returned: false,
          delegateEnded: false,
          ...(event.agentName ? { name: codexAgent(event.agentName) } : {}),
          ...(event.detail ? { described: event.detail } : {}),
        });
        delegatedFrom.set(event.toolUseId, target);
        // A new subagent for the step: the one cut off before is not its story.
        cutOffFor.delete(target);
        // A step announced in a batch, now started: a fan-out, not a move away.
        // Its subagent is what makes it run beside the step announced after
        // it, which may be one the workflow runs only once it is done.
        if (pendingClose.delete(target) && announced && announced !== target && isOpen(announced)) {
          noteOverlaps(announced, event.at, blocks[announced].passes);
        }
        // A step left a moment before its subagent was started was not
        // finished: the same pass goes on. But once the session has worked in
        // the step it moved to, a subagent for a finished step is the session
        // coming back to it — a new pass, which its line will then confirm
        // (ANT-184).
        if (target !== announced && blocks[target].state === "done" && !finishedAt) {
          // Closed with nothing done in it, when the session went on to other
          // work: announced with its sibling, then set up for (ANT-217). Its
          // subagent says it was not over, and this is the same pass.
          if (!workSinceEntered || closedEmpty.has(target)) reopen(target);
          else {
            const pass = blocks[target].passes + 1;
            blocks[target] = { ...blocks[target], state: "running", enteredAt: event.at, passes: pass };
            spans.push({ blockId: target, pass, startedAt: event.at });
            openedByDispatch.add(target);
          }
        }
        // A step nothing announced, begun by the subagent started for it. The
        // session itself stays where it is.
        if (blocks[target].state === "queued") {
          blocks[target] = { state: "running", confidence: "exact", enteredAt: event.at, passes: 1 };
          spans.push({ blockId: target, pass: 1, startedAt: event.at });
          openedByDispatch.add(target);
        }
      }
    }

    // And its result coming back to the session.
    // Read from the transcript, which says whether the subagent was sent off
    // on its own; a hook alone cannot, and would call the launch receipt the
    // subagent coming back (ANT-164).
    const returning =
      event.kind === "tool.end" && event.toolUseId && !hookOnly ? delegations.get(event.toolUseId) : undefined;
    if (returning) {
      returning.returned = true;
      // The receipt of a subagent sent off on its own: it is not back yet.
      if (event.background) {
        returning.background = true;
        returning.sentOff = true;
      }
      release(returning.blockId, event.at);
    }

    // The session saying the work is over. It settles every step still open
    // outright: it is the record the hooks' silence was only ever standing in
    // for (ANT-78), so it needs no hooks to be believed. A failure already
    // recorded stays a failure, and steps nobody announced stay unreached —
    // the session ending does not prove every branch of the workflow ran.
    const completion = completionOf(event);
    if (completion) {
      // A turn record after the harness's done is the same ending told again;
      // the harness's word is the stronger one and stays.
      if (event.channel === "anthill:report") doneReported = true;
      finishedAt = event.at;
      for (const id of [...pendingClose.keys()]) closePending(id);
      for (const id of Object.keys(blocks)) finish(id, event.at);
      delegations.clear();
      askedSinceEntered = false;
      continue;
    }

    // The session stopped by hand: over for now, and not asking anybody
    // anything. Waiting on the person only in that nothing goes on until
    // they type again, so it is never presented as a question (ANT-204).
    if (resumesWork(event)) sessionStopped = false;
    if (event.kind === "notification" && event.title === STOPPED_BY_HAND) {
      if (!finishedAt) sessionStopped = true;
      if (!finishedAt && announced && blocks[announced]?.state === "running") {
        stoppedHere = true;
        blocks[announced] = {
          ...blocks[announced],
          state: "needsYou",
          note: STOPPED_HERE_NOTE,
          waitReason: "yielded",
        };
      }
      continue;
    }

    if (event.kind === "notification" && announced) askedSinceEntered = true;

    if (
      finishedAt &&
      announced &&
      blocks[announced]?.state === "done" &&
      // The harness reporting a step again is how it takes its done back.
      !(doneReported && event.kind === "step.marker" && event.channel === "anthill:report")
    ) {
      /*
        After the harness's own done, nothing the session does is this run's
        until the harness reports again (ANT-303). Codex ran `anthill done`,
        wrote its final record, and the person then gave the same session
        another job: each of those reopened the last step, and the new job's
        subagents left it "Unknown" when the run finally settled. A report
        through the CLI is an `enter`, which clears this.
      */
      if (doneReported) continue;
      // After the ending: a turn ending again says nothing new, a real request
      // for a person is still one, and new work is the session going on.
      if (event.kind === "notification") {
        blocks[announced] = {
          ...blocks[announced],
          state: "needsYou",
          note: event.detail ?? event.title,
          waitReason: "asked",
        };
        spans.push({ blockId: announced, pass: blocks[announced].passes, startedAt: event.at });
        finishedAt = undefined;
      } else if (
        resumesWork(event) &&
        event.kind !== "session.start" &&
        !(event.toolUseId && plumbing.has(event.toolUseId)) &&
        // A call only the hooks saw, after the ending: Claude Code's own
        // helper, which fires hooks under the session and is in no
        // transcript (ANT-218).
        !(hookOnly && event.kind === "tool.start")
      ) {
        blocks[announced] = { ...blocks[announced], state: "running", enteredAt: event.at };
        spans.push({ blockId: announced, pass: blocks[announced].passes, startedAt: event.at });
        finishedAt = undefined;
      }
      continue;
    }

    // A turn ending while subagents it started are still out is the session
    // waiting for them, not for a person: it will be prompted again when they
    // report back (ANT-163). Its own request for a person still counts.
    // So is one ending while a command it sent to the background still runs:
    // the step is that command at work, not a question put to a person
    // (ANT-308).
    const waitingOnSubagents =
      event.kind === "turn.end" &&
      ([...delegations.values()].some((d) => !settled(d)) || backgroundCommands.size > 0);
    if (
      yieldsToYou(event) &&
      !waitingOnSubagents &&
      announced &&
      blocks[announced]?.state === "running"
    ) {
      blocks[announced] = {
        ...blocks[announced],
        state: "needsYou",
        note:
          event.kind === "turn.end"
            ? "The agent ended its turn here and has not started anything since."
            : (event.detail ?? event.title),
        waitReason: event.kind === "notification" ? "asked" : "yielded",
      };
      continue;
    }

    // And back out again, so the state follows the session rather than
    // latching onto the first yield of the run.
    if (resumesWork(event) && announced && blocks[announced]?.state === "needsYou") {
      const waiting = blocks[announced];
      const { note: _left, waitReason: _why, ...rest } = waiting;
      blocks[announced] = { ...rest, state: "running" };
      stoppedHere = false;
      continue;
    }

    // A recorded failure settles the announced step, but never invents one.
    if (event.kind === "error" && announced && blocks[announced]) {
      if (isOpen(announced)) finish(announced, event.at, "failed", event.detail ?? event.title);
      else blocks[announced] = { ...blocks[announced], state: "failed", note: event.detail ?? event.title };
    }
  }

  // The run's own state has the last word on anything still in flight.
  if (announced && blocks[announced]) {
    const open = isOpen(announced);
    // A run reaches `completed` by reading a terminal stop reason followed by
    // a long silence — which is the exact shape of a turn that ended with a
    // question, because the silence is the person not having answered yet. The
    // block's own record says the agent yielded and nothing has started since,
    // and that record beats an inference drawn from the same silence: the step
    // stays amber rather than being declared finished at the point where
    // somebody is still needed.
    //
    // Unless the hooks were carrying the run and the only thing that put the
    // step there was the turn ending (ANT-78). With hooks, a real wait writes
    // a `notification` — a permission prompt, the CLI's own "waiting for your
    // input" — and none came since this step began. The last step of every
    // finished workflow ends with a turn ending and has no later marker to
    // move it on, so without this no finished run could ever go green. With
    // no hooks the two cases are indistinguishable, and the amber stays.
    // Never at an Approval Gate. A turn that ends at the gate is the gate's
    // question put to a person, with or without the CLI's own "waiting for
    // your input" — which a headless run, or a person who closes the session
    // there, never produces. Only the next step, or the session's own word that
    // the work is done, gets past a gate (ANT-176).
    const atGate = gates.has(announced);
    const yieldedOnlyByTurnEnd =
      blocks[announced].state === "needsYou" && hooksCarried && !askedSinceEntered && !atGate;
    // Stopped by hand and never taken up again: the session is over, so it is
    // not waiting on anybody.
    const stoppedAndEnded = blocks[announced].state === "needsYou" && stoppedHere && !askedSinceEntered;
    if (open && atGate && run.state === "completed") {
      const { note: _note, waitReason: _why, ...rest } = blocks[announced];
      blocks[announced] = {
        ...rest,
        state: "needsYou",
        note: "The session stopped at this approval, and nobody answered it.",
        waitReason: "asked",
      };
    } else if (
      open &&
      run.state === "completed" &&
      (blocks[announced].state !== "needsYou" || yieldedOnlyByTurnEnd || stoppedAndEnded)
    ) {
      // Nothing announced a departure, so the last thing anything was recorded
      // at is as close as the record gets to when this step stopped.
      if (lastSeenAt) {
        if (stoppedFor.has(announced)) finish(announced, lastSeenAt, "failed", STOPPED_NOTE);
        else if (outstanding(announced) || cutOffFor.has(announced)) finish(announced, lastSeenAt, "unknown", CUT_OFF_NOTE);
        else if (stoppedAndEnded) finish(announced, lastSeenAt, "failed", STOPPED_HERE_NOTE);
        else if (failedIn.get(announced)?.size) {
          finish(announced, lastSeenAt, "unknown", UNFINISHED_NOTE([...(failedIn.get(announced) ?? [])][0]));
        } else finish(announced, lastSeenAt);
      }
    } else if (open && run.state === "failed") {
      finish(announced, lastSeenAt ?? run.lastObservedAt ?? run.createdAt, "failed", run.statusMessage);
    } else if (open && run.state === "observation_lost" && sessionStopped) {
      const at = lastSeenAt ?? run.createdAt;
      if (stoppedFor.has(announced)) finish(announced, at, "failed", STOPPED_NOTE);
      else if (outstanding(announced) || cutOffFor.has(announced)) finish(announced, at, "unknown", CUT_OFF_NOTE);
      else finish(announced, at, "failed", STOPPED_HERE_NOTE);
    } else if (open && (run.state === "observation_lost" || run.state === "ambiguous_match")) {
      finish(announced, lastSeenAt ?? run.createdAt, "unknown", "Anthill stopped being able to read this session.");
    }
  }
  // A step left with nothing done, never started after: over as of leaving.
  if (run.state === "completed") for (const id of [...pendingClose.keys()]) closePending(id);
  detours.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  overlaps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Steps a subagent was still holding open when the run settled: the run's
  // word goes for them too, not only for the step the session was last on.
  for (const id of Object.keys(blocks)) {
    if (id === announced || blocks[id].state !== "running") continue;
    const at = lastSeenAt ?? run.createdAt;
    if (run.state === "completed") {
      if (stoppedFor.has(id)) finish(id, at, "failed", STOPPED_NOTE);
      else if (outstanding(id) || cutOffFor.has(id)) finish(id, at, "unknown", CUT_OFF_NOTE);
      else finish(id, at);
    }
    else if (run.state === "failed") finish(id, at, "failed", run.statusMessage);
    else if (run.state === "observation_lost" && sessionStopped) {
      if (stoppedFor.has(id)) finish(id, at, "failed", STOPPED_NOTE);
      else finish(id, at, "unknown", CUT_OFF_NOTE);
    }
    else if (run.state === "observation_lost" || run.state === "ambiguous_match") {
      finish(id, at, "unknown", "Anthill stopped being able to read this session.");
    }
  }

  const active =
    announced && blocks[announced]?.state === "running" ? announced : undefined;
  const activeBlockIds = Object.keys(blocks).filter((id) => blocks[id].state === "running");
  // Only the CLI's opening record was seen: that is still when things began.
  startedAt ??= sessionOpenedAt;

  return {
    blocks,
    ...(active ? { activeBlockId: active } : {}),
    activeBlockIds,
    spans,
    detours,
    overlaps,
    events: attributed,
    unmappedCount,
    ...(startedAt ? { startedAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(finishedAt ? { endedAt: finishedAt } : {}),
    empty: events.length === 0,
  };
}

/**
 * Whether the graph can say anything at all about per-step progress.
 *
 * False when the agent never printed a step marker — which is a normal outcome,
 * not a failure, and the page says so rather than showing an all-queued diagram
 * as though nothing had happened.
 */
export function hasStepEvidence(view: LiveSessionView): boolean {
  return Object.values(view.blocks).some((block) => block.state !== "queued");
}

/**
 * How many steps are finished now: whose current pass is over.
 *
 * A step the agent has come back to is working again, and is not counted
 * until that pass ends. Counting it on the strength of an earlier pass read
 * "3 of 3 steps finished" over a rework loop's "Run tests" still drawn as
 * working on its second pass (ANT-243) — a header claiming the run complete
 * while the diagram under it said otherwise. The count can fall when the agent
 * returns to a step; that is the step being reopened, and the step's own
 * "pass 2" says so. It is the same reading as the ended report's "N done".
 */
export function finishedSteps(view: LiveSessionView): number {
  return Object.values(view.blocks).filter((block) => block.state === "done").length;
}
