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
import { mergeChannels } from "./channels.js";
import type { ObservationEvent } from "./observation-event.js";
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
};

export type AttributedEvent = ObservationEvent & { mapping: BlockMapping };

export type LiveSessionView = {
  /** Keyed by block id, covering every block in the workflow. */
  blocks: Record<string, BlockView>;
  /** The block the agent last announced, if it has not since left it. */
  activeBlockId?: string;
  /** Every event, oldest first, each with how it was attributed. */
  events: AttributedEvent[];
  /** Events no block could be claimed for. Shown as session-level activity. */
  unmappedCount: number;
  startedAt?: string;
  lastSeenAt?: string;
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
  let startedAt: string | undefined;
  let lastSeenAt: string | undefined;
  let unmappedCount = 0;
  const attributed: AttributedEvent[] = [];

  // One action, however many channels wrote it down. A session with hooks
  // installed is described twice over, and everything below counts what it
  // iterates: the same step announced once arrived twice and was drawn as a
  // second pass through the block (ANT-48).
  for (const event of mergeChannels(events)) {
    const mapping = attribute(event, index, announced);
    attributed.push({ ...event, mapping });
    // Usage is bookkeeping, not activity; counting it against "events not
    // mapped to a step" would make every quiet turn look like a mystery.
    if (mapping.confidence === "unmapped" && event.kind !== "usage") unmappedCount += 1;

    startedAt ??= event.at;
    lastSeenAt = event.at;

    // Only an exact marker moves the graph.
    if (mapping.confidence === "exact" && mapping.blockId) {
      if (announced && announced !== mapping.blockId) {
        const leaving = blocks[announced];
        // A step the agent left without failing is as done as Anthill can say.
        if (leaving && (leaving.state === "running" || leaving.state === "needsYou")) {
          const spent = spentBy(leaving, event.at);
          blocks[announced] = {
            ...leaving,
            state: "done",
            ...(spent !== undefined ? { spentMs: spent } : {}),
          };
        }
      }
      const entering = blocks[mapping.blockId];
      blocks[mapping.blockId] = {
        state: "running",
        confidence: "exact",
        enteredAt: event.at,
        // Carried, not reset: what earlier passes cost is still part of what
        // this step has cost.
        ...(entering?.spentMs !== undefined ? { spentMs: entering.spentMs } : {}),
        passes: (entering?.passes ?? 0) + 1,
      };
      announced = mapping.blockId;
      continue;
    }

    if (yieldsToYou(event) && announced && blocks[announced]?.state === "running") {
      blocks[announced] = {
        ...blocks[announced],
        state: "needsYou",
        note:
          event.kind === "turn.end"
            ? "The agent ended its turn here and has not started anything since."
            : (event.detail ?? event.title),
      };
      continue;
    }

    // And back out again, so the state follows the session rather than
    // latching onto the first yield of the run.
    if (resumesWork(event) && announced && blocks[announced]?.state === "needsYou") {
      const waiting = blocks[announced];
      const { note: _left, ...rest } = waiting;
      blocks[announced] = { ...rest, state: "running" };
      continue;
    }

    // `anthill done` is an explicit statement from the harness that the bound
    // workflow finished. It is stronger than a later generic turn-end record:
    // that record only says Codex yielded, while this marker says the work is
    // complete. Settle the active block here so a following `turn.end` cannot
    // turn a completed final step back into "Waiting on you".
    if (
      event.kind === "session.end" &&
      event.source === "anthill" &&
      event.channel === "anthill:report" &&
      announced &&
      blocks[announced]
    ) {
      const current = blocks[announced];
      const spent = spentBy(current, event.at);
      blocks[announced] = {
        ...current,
        state: "done",
        ...(spent !== undefined ? { spentMs: spent } : {}),
      };
      continue;
    }

    // A recorded failure settles the announced step, but never invents one.
    if (event.kind === "error" && announced && blocks[announced]) {
      blocks[announced] = {
        ...blocks[announced],
        state: "failed",
        note: event.detail ?? event.title,
      };
    }
  }

  // The run's own state has the last word on anything still in flight.
  if (announced && blocks[announced]) {
    const open = blocks[announced].state === "running" || blocks[announced].state === "needsYou";
    // A run reaches `completed` by reading a terminal stop reason followed by
    // a long silence — which is the exact shape of a turn that ended with a
    // question, because the silence is the person not having answered yet. The
    // block's own record says the agent yielded and nothing has started since,
    // and that record beats an inference drawn from the same silence: the step
    // stays amber rather than being declared finished at the point where
    // somebody is still needed.
    if (open && run.state === "completed" && blocks[announced].state !== "needsYou") {
      // Nothing announced a departure, so the last thing anything was recorded
      // at is as close as the record gets to when this step stopped.
      const spent = lastSeenAt ? spentBy(blocks[announced], lastSeenAt) : blocks[announced].spentMs;
      blocks[announced] = {
        ...blocks[announced],
        state: "done",
        ...(spent !== undefined ? { spentMs: spent } : {}),
      };
    } else if (open && run.state === "failed") {
      blocks[announced] = { ...blocks[announced], state: "failed", note: run.statusMessage };
    } else if (open && (run.state === "observation_lost" || run.state === "ambiguous_match")) {
      blocks[announced] = {
        ...blocks[announced],
        state: "unknown",
        note: "Anthill stopped being able to read this session.",
      };
    }
  }

  const active =
    announced && blocks[announced]?.state === "running" ? announced : undefined;

  return {
    blocks,
    ...(active ? { activeBlockId: active } : {}),
    events: attributed,
    unmappedCount,
    ...(startedAt ? { startedAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
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
