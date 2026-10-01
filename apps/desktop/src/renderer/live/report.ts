/**
 * What a finished session amounts to, derived from the drawn scene (ANT-142).
 *
 * The page answered "what happened?" well — the graph and the feed are the
 * evidence — and "what came of it, and what now?" badly. This is the fold that
 * answers the second question, and it is deliberately built from nothing but
 * what the page already draws: the folded view (so every count agrees with
 * the graph above it), the journal's own metrics (so every number comes back
 * identical after a restart), and the workflow's agent assignments.
 *
 * Three rules run through all of it:
 *
 * - **Finished is not succeeded.** A session that stopped is described as
 *   having stopped; nothing here reads a verdict on the work out of it.
 * - **Missing is not zero.** A step with no recording has no token figure at
 *   all, and a step never reached has no row of numbers — it says it was not
 *   reached. Zero is a measurement, and nobody made one.
 * - **Inference is labelled.** Time comes from the agent's own announcements;
 *   per-step tokens are recordings that fell inside an announced step, which
 *   is a presumption and is carried as one. Tokens outside any step stay
 *   unattributed and are never spread across steps to make a table add up.
 */

import type { Workflow } from "@anthill/workflow-schema";
import type {
  AttributedEvent,
  BlockRunState,
  LiveSessionView,
  PendingRun,
  SessionMetrics,
  TokenTally,
} from "@anthill/live";
import { agentProfiles, agentConfig } from "@anthill/workflow";

export type EndState = "completed" | "failed" | "lost" | "stopped";

/**
 * Whether the run has ended, and how.
 *
 * `observation_lost` counts even while Anthill is still listening for the
 * session to come back: the page is then describing what it last knew, and
 * says so, rather than pretending the session is still visibly running.
 */
export function endStateOf(run: PendingRun): EndState | undefined {
  if (run.state === "completed") return "completed";
  if (run.state === "failed") return "failed";
  // The person pressed Stop: closed, and known to be (ANT-241). Not the author
  // stopping observation, which is still a session nobody can see (ANT-191).
  if (run.state === "observation_lost" && run.stoppedByHandAt && !run.observationStoppedAt) return "stopped";
  if (run.state === "observation_lost") return "lost";
  return undefined;
}

export const END_TITLE: Record<EndState, string> = {
  completed: "Session finished",
  failed: "Ended with an error",
  lost: "Lost contact with the session",
  stopped: "Stopped by hand",
};

/** Where a block ended up, as the report groups them. */
export type Outcome = "done" | "failed" | "unknown" | "notReached" | "waiting";

export const OUTCOME_ORDER: Outcome[] = ["done", "failed", "waiting", "unknown", "notReached"];

export function outcomeOf(state: BlockRunState): Outcome {
  switch (state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
    case "queued":
      return "notReached";
    // A session that ended on a step still waiting for a person, or still
    // marked as working because nothing said otherwise.
    case "needsYou":
    case "running":
      return "waiting";
  }
}

export function outcomeWord(outcome: Outcome, count: number): string {
  switch (outcome) {
    case "done":
      return `${count} done`;
    case "failed":
      return `${count} failed`;
    case "unknown":
      return `${count} unknown`;
    case "notReached":
      return `${count} not reached`;
    case "waiting":
      return `${count} waiting on you`;
  }
}

/** The block ids in each outcome, in workflow order. Every count is one of these lists. */
export function outcomes(workflow: Workflow, view: LiveSessionView): Map<Outcome, string[]> {
  const byOutcome = new Map<Outcome, string[]>();
  for (const node of workflow.nodes) {
    const block = view.blocks[node.id];
    if (!block) continue; // Start and End carry no work of their own.
    const outcome = outcomeOf(block.state);
    byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), node.id]);
  }
  return byOutcome;
}

/** Where the verdict comes from, in words. Never more than the record supports. */
export function verdictSource(end: EndState, events: readonly AttributedEvent[]): string {
  if (end === "lost") return "the last record Anthill could read";
  if (end === "stopped") return "the session's record of your stop";
  if (end === "failed") {
    return events.some((event) => event.kind === "error")
      ? "the session's error record"
      : "the run's recorded failure";
  }
  if (events.some((event) => event.kind === "session.end" && event.channel === "anthill:report")) {
    return "the agent's own report that the workflow finished";
  }
  if (events.some((event) => event.kind === "session.end" || event.kind === "turn.end")) {
    return "the session's stop record";
  }
  return "the last record Anthill read";
}

/**
 * The last thing the agent said to the person, when one was recorded.
 *
 * Only the main session's words, and only as the excerpt the feed already
 * shows. `asksUser` only when the CLI recorded a request for a person on the
 * step still waiting — a step left amber because a turn ended with nothing
 * after it is the cautious reading of a silence, not a question put, and the
 * words are then only what the agent said (ANT-158). `stale` when contact was
 * lost, because a later message may simply not have arrived.
 */
export type LastWords = {
  text: string;
  at: string;
  asksUser: boolean;
  stale: boolean;
  /**
   * The session said the work was done and has not finished that turn yet.
   * Its closing reply comes seconds after the done line, so the last message
   * so far is an earlier progress note — "Both tests fail" — and quoting it as
   * what the agent said misreported a run that passed (ANT-186).
   */
  closing: boolean;
};

/** How long after the done line a closing reply is still worth waiting for. */
const CLOSING_REPLY_MS = 2 * 60_000;

export function lastWords(view: LiveSessionView, end: EndState, now: number = Date.now()): LastWords | undefined {
  const message = [...view.events]
    .reverse()
    .find((event) => event.kind === "message" && event.author?.kind !== "subagent" && event.detail);
  if (!message?.detail) return undefined;
  const endedAt = view.endedAt ? Date.parse(view.endedAt) : undefined;
  const turnEnded =
    endedAt !== undefined &&
    view.events.some(
      (event) => event.kind === "turn.end" && event.author?.kind !== "subagent" && Date.parse(event.at) >= endedAt,
    );
  return {
    text: message.detail,
    at: message.at,
    asksUser: Object.values(view.blocks).some(
      (block) => block.state === "needsYou" && block.waitReason === "asked",
    ),
    stale: end === "lost",
    // Not for ever: a turn whose end is never recorded does not hold the
    // quote back past a couple of minutes.
    closing:
      end === "completed" &&
      endedAt !== undefined &&
      !turnEnded &&
      Date.parse(message.at) < endedAt &&
      now - endedAt < CLOSING_REPLY_MS,
  };
}

/** One pass through a step: its announced time and what was recorded inside it. */
export type PassUsage = { pass: number; durationMs?: number; tokens?: TokenTally };

export type BlockUsage = {
  blockId: string;
  name: string;
  outcome: Outcome;
  /** Every pass, in order. Empty for a step never reached. */
  passes: PassUsage[];
  /** Summed over passes that ended. Absent when none did. */
  durationMs?: number;
  /** Summed over passes. Absent when nothing was recorded for this step. */
  tokens?: TokenTally;
  agent?: string;
};

export type AgentUsage = {
  name: string;
  /** Only the steps this agent was assigned that were actually reached. */
  blockIds: string[];
  durationMs?: number;
  tokens?: TokenTally;
};

export type SessionUsage = {
  durationMs?: number;
  tokensRecorded?: TokenTally;
  tokensUnattributed?: TokenTally;
  blocks: BlockUsage[];
  agents: AgentUsage[];
};

const add = (a: TokenTally | undefined, b: TokenTally | undefined): TokenTally | undefined =>
  !b ? a : { in: (a?.in ?? 0) + b.in, out: (a?.out ?? 0) + b.out };

export function sessionUsage(
  workflow: Workflow,
  view: LiveSessionView,
  metrics: SessionMetrics,
  endedAt: string | undefined,
): SessionUsage {
  const profiles = new Map(agentProfiles(workflow).map((profile) => [profile.id, profile.name]));
  const blocks: BlockUsage[] = [];

  for (const node of workflow.nodes) {
    const block = view.blocks[node.id];
    if (!block) continue;
    const spans = metrics.spans.filter((span) => span.blockId === node.id);
    // One entry per pass, not per span: a pass the session carried on with
    // after saying it was done — or came back to after waiting on you — is
    // the same pass in two stretches, and counting stretches reported
    // "2 passes" for a step that ran once (ANT-184).
    const passes: PassUsage[] = [];
    for (const span of spans) {
      const same = passes.find((pass) => pass.pass === span.pass);
      if (!same) {
        passes.push({
          pass: span.pass,
          ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
          ...(span.tokens ? { tokens: { ...span.tokens } } : {}),
        });
        continue;
      }
      if (span.durationMs !== undefined) same.durationMs = (same.durationMs ?? 0) + span.durationMs;
      if (span.tokens) {
        same.tokens = { in: (same.tokens?.in ?? 0) + span.tokens.in, out: (same.tokens?.out ?? 0) + span.tokens.out };
      }
    }
    const ended = passes.filter((pass) => pass.durationMs !== undefined);
    const tokens = metrics.tokensLikelyByBlock.get(node.id);
    const agentId = agentConfig(node).agentId;
    const agent = agentId ? profiles.get(agentId) : undefined;
    blocks.push({
      blockId: node.id,
      name: node.name,
      outcome: outcomeOf(block.state),
      passes,
      ...(ended.length > 0 ? { durationMs: ended.reduce((sum, pass) => sum + (pass.durationMs ?? 0), 0) } : {}),
      ...(tokens ? { tokens } : {}),
      ...(agent ? { agent } : {}),
    });
  }

  // Grouped by the workflow's agent assignment, over the steps actually
  // reached — never by which runtime agent really did the work, which the
  // record does not say.
  const agents = new Map<string, AgentUsage>();
  for (const block of blocks) {
    if (!block.agent) continue;
    if (block.passes.length === 0 && !block.tokens) continue;
    const current = agents.get(block.agent) ?? { name: block.agent, blockIds: [] };
    const durationMs =
      block.durationMs === undefined ? current.durationMs : (current.durationMs ?? 0) + block.durationMs;
    const tokens = add(current.tokens, block.tokens);
    agents.set(block.agent, {
      name: block.agent,
      blockIds: [...current.blockIds, block.blockId],
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(tokens ? { tokens } : {}),
    });
  }

  const start = view.startedAt ? Date.parse(view.startedAt) : NaN;
  const stop = endedAt ? Date.parse(endedAt) : NaN;
  const durationMs = Number.isNaN(start) || Number.isNaN(stop) || stop < start ? undefined : stop - start;

  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(metrics.tokensRecorded ? { tokensRecorded: metrics.tokensRecorded } : {}),
    ...(metrics.tokensUnattributed ? { tokensUnattributed: metrics.tokensUnattributed } : {}),
    blocks,
    agents: [...agents.values()],
  };
}

/** "42k", "1.2k", "860" — a figure read at a glance, never rounded to nothing. */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/**
 * Tokens as a report shows them: `~` when the figure is a presumed share of
 * the session's recordings, and "no token data" rather than a zero.
 */
export function tokenLine(tokens: TokenTally | undefined, presumed: boolean): string {
  if (!tokens) return "no token data";
  const mark = presumed ? "~" : "";
  return `${mark}${compact(tokens.in)} in · ${mark}${compact(tokens.out)} out`;
}
