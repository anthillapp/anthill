/**
 * What a session's numbers honestly support.
 *
 * Everything here is folded from the journal, so a summary drawn live and one
 * rebuilt after a restart agree. Two different strengths of claim, kept apart
 * the whole way through:
 *
 * - **Time is span arithmetic over exact markers.** A step's span runs from
 *   its announcement to the next announcement — both the agent's own words —
 *   so durations are as authoritative as the graph itself. A span nothing has
 *   ended yet is open, and stays open unless the session is settled; it never
 *   grows a fabricated end.
 * - **Tokens are the harness's own recordings, attributed like any other
 *   event.** The session total is the sum of what was recorded — no more, and
 *   labelled as recorded rather than complete, because a harness is free to
 *   record usage for some work and not other. Per-step tokens exist only where
 *   a recording fell inside an announced step, which is an inference and is
 *   carried as one; recordings outside any step stay unattributed. A session
 *   total is never divided among steps to make the table look finished.
 */

import type { AttributedEvent } from "./live-session.js";

export type BlockSpan = {
  blockId: string;
  /** 1-based. A rework loop announces the same step more than once. */
  pass: number;
  startedAt: string;
  /** The next announcement, or the settle time. Absent while still open. */
  endedAt?: string;
  durationMs?: number;
};

export type TokenTally = { in: number; out: number };

export type SessionMetrics = {
  /** Every announced step occurrence, in order. Exact evidence only. */
  spans: BlockSpan[];
  /** Announcements per step. More than one means the workflow looped. */
  passesByBlock: Map<string, number>;
  /** Total announced time per step, over the spans that have ended. */
  timeByBlock: Map<string, number>;
  /** Sum of every usage recording in the journal. Recorded, not complete. */
  tokensRecorded?: TokenTally;
  /** Recordings that fell inside an announced step. An inference, labelled. */
  tokensLikelyByBlock: Map<string, TokenTally>;
  /** Recordings that fell outside any announced step. */
  tokensUnattributed?: TokenTally;
};

function add(tally: TokenTally | undefined, tokens: TokenTally): TokenTally {
  return { in: (tally?.in ?? 0) + tokens.in, out: (tally?.out ?? 0) + tokens.out };
}

/**
 * Fold the journal into numbers.
 *
 * `settledAt` is the moment the session stopped being observed as running —
 * completion, failure, or the close of a lost run. When given, the last open
 * span ends there; when absent, it stays honestly open.
 */
export function sessionMetrics(
  events: readonly AttributedEvent[],
  settledAt?: string,
): SessionMetrics {
  const spans: BlockSpan[] = [];
  const passesByBlock = new Map<string, number>();

  let tokensRecorded: TokenTally | undefined;
  let tokensUnattributed: TokenTally | undefined;
  const tokensLikelyByBlock = new Map<string, TokenTally>();

  for (const event of events) {
    if (event.kind === "step.marker" && event.mapping.confidence === "exact" && event.blockId) {
      const open = spans[spans.length - 1];
      if (open && !open.endedAt) {
        open.endedAt = event.at;
        open.durationMs = Date.parse(event.at) - Date.parse(open.startedAt);
      }
      const pass = (passesByBlock.get(event.blockId) ?? 0) + 1;
      passesByBlock.set(event.blockId, pass);
      spans.push({ blockId: event.blockId, pass, startedAt: event.at });
      continue;
    }

    if (event.kind === "usage" && event.tokens) {
      tokensRecorded = add(tokensRecorded, event.tokens);
      if (event.mapping.confidence !== "unmapped" && event.mapping.blockId) {
        tokensLikelyByBlock.set(
          event.mapping.blockId,
          add(tokensLikelyByBlock.get(event.mapping.blockId), event.tokens),
        );
      } else {
        tokensUnattributed = add(tokensUnattributed, event.tokens);
      }
    }
  }

  const open = spans[spans.length - 1];
  if (open && !open.endedAt && settledAt) {
    open.endedAt = settledAt;
    open.durationMs = Math.max(0, Date.parse(settledAt) - Date.parse(open.startedAt));
  }

  const timeByBlock = new Map<string, number>();
  for (const span of spans) {
    if (span.durationMs === undefined) continue;
    timeByBlock.set(span.blockId, (timeByBlock.get(span.blockId) ?? 0) + span.durationMs);
  }

  return {
    spans,
    passesByBlock,
    timeByBlock,
    ...(tokensRecorded ? { tokensRecorded } : {}),
    tokensLikelyByBlock,
    ...(tokensUnattributed ? { tokensUnattributed } : {}),
  };
}

/**
 * Announced time per agent, for a caller who knows which agent carries which
 * step. Spans without an ending are excluded — an open span has no duration to
 * assign, and inventing one would be a number the journal does not hold.
 */
export function timeByAgent(
  metrics: SessionMetrics,
  agentOf: (blockId: string) => string | undefined,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const span of metrics.spans) {
    if (span.durationMs === undefined) continue;
    const agent = agentOf(span.blockId);
    if (!agent) continue;
    totals.set(agent, (totals.get(agent) ?? 0) + span.durationMs);
  }
  return totals;
}
