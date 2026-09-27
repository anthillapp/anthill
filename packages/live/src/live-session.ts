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
  const spans: BlockSpanView[] = [];
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
   * running until the last of them comes back (ANT-163).
   */
  const leave = (id: string, at: string) => {
    if (!isOpen(id)) return;
    if (outstanding(id)) {
      const { note: _note, waitReason: _why, ...rest } = blocks[id];
      blocks[id] = { ...rest, state: "running" };
    } else {
      finish(id, at);
    }
  };

  const enter = (id: string, at: string, viaTag: boolean) => {
    const fanOut = announced !== undefined && announced !== id && outstanding(announced);
    if (announced && announced !== id) leave(announced, at);
    // Coming back to a step still open ends the pass it was on.
    if (isOpen(id)) finish(id, at);
    const entering = blocks[id];
    const pass = (entering?.passes ?? 0) + 1;
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
    // Only a move between two steps can be one the plan lacks: the first
    // step came from nowhere the fold can see, a step announced again is not
    // a move at all, and a step started while the last one's subagents are
    // still at work is the session fanning out, not leaving it.
    if (announced && announced !== id && !fanOut && !planned.has(`${announced}→${id}`)) {
      detours.push({ from: announced, to: id, at, pass });
    }
    announced = id;
    enteredByTag = viaTag;
    askedSinceEntered = false;
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

  /** A delegation came back: its step is done if nothing else holds it open. */
  const release = (id: string, at: string) => {
    if (id !== announced && isOpen(id) && !outstanding(id)) finish(id, at);
  };

  // One action, however many channels wrote it down. A session with hooks
  // installed is described twice over, and everything below counts what it
  // iterates: the same step announced once arrived twice and was drawn as a
  // second pass through the block (ANT-48).
  // And in the order it happened rather than the order it was read (ANT-159).
  for (const event of projectJournal(events)) {
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
    const via = event.parentToolUseId ? delegations.get(event.parentToolUseId) : undefined;
    if (via || event.author?.kind === "subagent") {
      if (via && event.kind === "turn.end") {
        via.delegateEnded = true;
        release(via.blockId, event.at);
      }
      continue;
    }

    // Only a step line moves the graph. A tag and a subagent's work say which
    // step something belongs to; they are not the agent saying where it is.
    if (event.kind === "step.marker" && mapping.confidence === "exact" && mapping.blockId) {
      if (mapping.blockId === announced && enteredByTag) {
        // The line confirming a step its messages had already named.
        enteredByTag = false;
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
      put the step's tag in what it handed over, else the step the session is
      on. The call's own word comes first because the session can announce
      several steps and only then start their subagents together — measured,
      that is exactly how Claude Code fans out, and by the moment of dispatch
      every subagent looked like the last-announced step's (ANT-163).
    */
    if (event.kind === "subagent.start" && event.toolUseId) {
      const target = event.stepTag && blocks[event.stepTag] ? event.stepTag : announced;
      if (target && blocks[target]) {
        delegations.set(event.toolUseId, {
          blockId: target,
          background: event.background === true,
          returned: false,
          delegateEnded: false,
        });
        delegatedFrom.set(event.toolUseId, target);
        // A step left a moment before its subagent was started was not
        // finished: the same pass goes on.
        if (target !== announced && blocks[target].state === "done" && !finishedAt) reopen(target);
        // A step nothing announced, begun by the subagent started for it. The
        // session itself stays where it is.
        if (blocks[target].state === "queued") {
          blocks[target] = { state: "running", confidence: "exact", enteredAt: event.at, passes: 1 };
          spans.push({ blockId: target, pass: 1, startedAt: event.at });
        }
      }
    }

    // And its result coming back to the session.
    const returning = event.kind === "tool.end" && event.toolUseId ? delegations.get(event.toolUseId) : undefined;
    if (returning) {
      returning.returned = true;
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
      for (const id of Object.keys(blocks)) finish(id, event.at);
      delegations.clear();
      askedSinceEntered = false;
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
    const yieldedOnlyByTurnEnd =
      blocks[announced].state === "needsYou" && hooksCarried && !askedSinceEntered;
    if (
      open &&
      run.state === "completed" &&
      (blocks[announced].state !== "needsYou" || yieldedOnlyByTurnEnd)
    ) {
      // Nothing announced a departure, so the last thing anything was recorded
      // at is as close as the record gets to when this step stopped.
      if (lastSeenAt) finish(announced, lastSeenAt);
    } else if (open && run.state === "failed") {
      finish(announced, lastSeenAt ?? run.lastObservedAt ?? run.createdAt, "failed", run.statusMessage);
    } else if (open && (run.state === "observation_lost" || run.state === "ambiguous_match")) {
      finish(announced, lastSeenAt ?? run.createdAt, "unknown", "Anthill stopped being able to read this session.");
    }
  }
  // Steps a subagent was still holding open when the run settled: the run's
  // word goes for them too, not only for the step the session was last on.
  for (const id of Object.keys(blocks)) {
    if (id === announced || blocks[id].state !== "running") continue;
    const at = lastSeenAt ?? run.createdAt;
    if (run.state === "completed") finish(id, at);
    else if (run.state === "failed") finish(id, at, "failed", run.statusMessage);
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
