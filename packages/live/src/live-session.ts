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

import { attribute, buildWorkflowIndex, type BlockMapping, type WorkflowIndex } from "./attribution.js";
import { projectJournal } from "./channels.js";
import { completionOf, type ObservationEvent } from "./observation-event.js";
import type { PendingRun } from "./pending-run.js";

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
    { blockId: string; background: boolean; returned: boolean; delegateEnded: boolean }
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
  const endedByHook = new Set<string>();
  let hooksOwed = 0;
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
  let sessionOpenedAt: string | undefined;
  let startedAt: string | undefined;
  let lastSeenAt: string | undefined;
  let unmappedCount = 0;
  const attributed: AttributedEvent[] = [];
  const detours: Detour[] = [];
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
  /** The Approval Gates: a person decides there, and nothing else settles one. */
  const gates = new Set(workflow.nodes.filter((node) => node.type === "approval").map((node) => node.id));

  const isOpen = (id: string) => blocks[id]?.state === "running" || blocks[id]?.state === "needsYou";
  const settled = (d: { background: boolean; returned: boolean; delegateEnded: boolean }) =>
    d.background ? d.delegateEnded : d.returned;
  /** Whether a step still has a subagent working for it. */
  const outstanding = (id: string) =>
    [...delegations.values()].some((d) => d.blockId === id && !settled(d));

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
  const closePending = (id: string) => {
    const pending = pendingClose.get(id);
    if (!pending) return;
    pendingClose.delete(id);
    finish(id, pending.leftAt);
    if (pending.detour) detours.push(pending.detour);
  };

  const enter = (id: string, at: string, viaTag: boolean) => {
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

  /** A delegation came back: its step is done if nothing else holds it open. */
  const release = (id: string, at: string) => {
    if (id !== announced && isOpen(id) && !outstanding(id)) {
      if (stoppedFor.has(id)) finish(id, at, "failed", STOPPED_NOTE);
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
    if (
      event.kind === "message" &&
      event.parentToolUseId &&
      event.stepTag &&
      !saysItWorksOn.has(event.parentToolUseId)
    ) {
      saysItWorksOn.set(event.parentToolUseId, event.stepTag);
    }
  }
  for (const event of journal) {
    const mapping = attribute(event, index, announced, delegatedFrom);
    attributed.push({ ...event, mapping });
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
    if (event.kind === "subagent.end" && !event.parentToolUseId && event.channel.endsWith(":hook")) {
      if (hooksOwed > 0) {
        hooksOwed -= 1;
      } else {
        const at = Date.parse(event.at);
        let best: string | undefined;
        for (const [call, heard] of lastHeard) {
          const d = delegations.get(call);
          if (!d || d.delegateEnded || Number.isNaN(at) || heard > at || at - heard > STOP_PAIRING_MS) continue;
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
    }
    if (via || event.parentToolUseId || event.author?.kind === "subagent") {
      if (via && event.kind === "turn.end") {
        if (!via.delegateEnded && !endedByHook.has(event.parentToolUseId ?? "")) hooksOwed += 1;
        via.delegateEnded = true;
        release(via.blockId, event.at);
      }
      // Stopped by the person: over, and not finished (ANT-190).
      if (via && event.kind === "notification" && event.title === STOPPED_BY_HAND) {
        via.delegateEnded = true;
        via.returned = true;
        stoppedFor.add(via.blockId);
        release(via.blockId, event.at);
      }
      continue;
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
      for (const id of [...pendingClose.keys()]) closePending(id);
    }
    // Starting a subagent, or saying something, is work in the step too — a
    // step done in words alone was done — but neither closes a batch-announced
    // step: the first is how such a step goes on, the second says nothing
    // about where the session is.
    if (event.kind === "subagent.start" || event.kind === "message") workSinceEntered = true;

    // Only a step line moves the graph. A tag and a subagent's work say which
    // step something belongs to; they are not the agent saying where it is.
    if (event.kind === "step.marker" && mapping.confidence === "exact" && mapping.blockId) {
      if (mapping.blockId === announced && !enteredByTag) {
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
      const target =
        event.stepTag && blocks[event.stepTag]
          ? event.stepTag
          : own && blocks[own]
            ? own
            : announced;
      if (target && blocks[target]) {
        delegations.set(event.toolUseId, {
          blockId: target,
          background: event.background === true,
          returned: false,
          delegateEnded: false,
        });
        delegatedFrom.set(event.toolUseId, target);
        // A step announced in a batch, now started: a fan-out, not a move away.
        pendingClose.delete(target);
        // A step left a moment before its subagent was started was not
        // finished: the same pass goes on. But once the session has worked in
        // the step it moved to, a subagent for a finished step is the session
        // coming back to it — a new pass, which its line will then confirm
        // (ANT-184).
        if (target !== announced && blocks[target].state === "done" && !finishedAt) {
          if (!workSinceEntered) reopen(target);
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
      if (event.background) returning.background = true;
      release(returning.blockId, event.at);
    }

    // The session saying the work is over. It settles every step still open
    // outright: it is the record the hooks' silence was only ever standing in
    // for (ANT-78), so it needs no hooks to be believed. A failure already
    // recorded stays a failure, and steps nobody announced stay unreached —
    // the session ending does not prove every branch of the workflow ran.
    const completion = completionOf(event);
    if (completion) {
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

    if (finishedAt && announced && blocks[announced]?.state === "done") {
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
      } else if (resumesWork(event) && event.kind !== "session.start") {
        blocks[announced] = { ...blocks[announced], state: "running", enteredAt: event.at };
        spans.push({ blockId: announced, pass: blocks[announced].passes, startedAt: event.at });
        finishedAt = undefined;
      }
      continue;
    }

    // A turn ending while subagents it started are still out is the session
    // waiting for them, not for a person: it will be prompted again when they
    // report back (ANT-163). Its own request for a person still counts.
    const waitingOnSubagents =
      event.kind === "turn.end" && [...delegations.values()].some((d) => !settled(d));
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
        else if (outstanding(announced)) finish(announced, lastSeenAt, "unknown", CUT_OFF_NOTE);
        else if (stoppedAndEnded) finish(announced, lastSeenAt, "failed", STOPPED_HERE_NOTE);
        else finish(announced, lastSeenAt);
      }
    } else if (open && run.state === "failed") {
      finish(announced, lastSeenAt ?? run.lastObservedAt ?? run.createdAt, "failed", run.statusMessage);
    } else if (open && run.state === "observation_lost" && sessionStopped) {
      const at = lastSeenAt ?? run.createdAt;
      if (stoppedFor.has(announced)) finish(announced, at, "failed", STOPPED_NOTE);
      else if (outstanding(announced)) finish(announced, at, "unknown", CUT_OFF_NOTE);
      else finish(announced, at, "failed", STOPPED_HERE_NOTE);
    } else if (open && (run.state === "observation_lost" || run.state === "ambiguous_match")) {
      finish(announced, lastSeenAt ?? run.createdAt, "unknown", "Anthill stopped being able to read this session.");
    }
  }
  // A step left with nothing done, never started after: over as of leaving.
  if (run.state === "completed") for (const id of [...pendingClose.keys()]) closePending(id);
  detours.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Steps a subagent was still holding open when the run settled: the run's
  // word goes for them too, not only for the step the session was last on.
  for (const id of Object.keys(blocks)) {
    if (id === announced || blocks[id].state !== "running") continue;
    const at = lastSeenAt ?? run.createdAt;
    if (run.state === "completed") {
      if (stoppedFor.has(id)) finish(id, at, "failed", STOPPED_NOTE);
      else if (outstanding(id)) finish(id, at, "unknown", CUT_OFF_NOTE);
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
 * How many steps have finished at least once.
 *
 * A step the agent has come back to is drawn as running again, and it is —
 * but the pass it finished before is still finished. Counting only `done`
 * blocks made "9 of 10 steps finished" fall to 8 the moment the agent
 * returned to one of the nine, which read as progress being undone rather
 * than as a step being visited twice.
 */
export function finishedSteps(view: LiveSessionView): number {
  return Object.values(view.blocks).filter(
    (block) =>
      block.state === "done" ||
      ((block.state === "running" || block.state === "needsYou") && block.passes > 1),
  ).length;
}
