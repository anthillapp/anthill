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

import type { AttributedEvent, BlockSpanView } from "./live-session.js";

export type BlockSpan = {
  blockId: string;
  /** 1-based. A rework loop announces the same step more than once. */
  pass: number;
  startedAt: string;
  /** The next announcement, or the settle time. Absent while still open. */
  endedAt?: string;
  durationMs?: number;
  /**
   * The recordings attributed to this span's step while it was the latest
   * pass through it. An inference, like the per-step figure it is a slice of:
   * a step's passes always sum to exactly its `tokensLikelyByBlock` entry, so a
   * loop can be read pass by pass without anything being counted twice.
   */
  tokens?: TokenTally;
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
  /**
   * The passes the fold found, when there are any to hand. They are the only
   * measure that holds once steps run side by side: a step a subagent is
   * still working for does not end when the session announces the next one
   * (ANT-163). Without them the spans are read off the step lines, one after
   * another, as they always were.
   */
  foldSpans?: readonly BlockSpanView[],
): SessionMetrics {
  if (foldSpans) return fromFoldSpans(events, foldSpans, settledAt);
  const spans: BlockSpan[] = [];
  const passesByBlock = new Map<string, number>();

  let tokensRecorded: TokenTally | undefined;
  let tokensUnattributed: TokenTally | undefined;
  const tokensLikelyByBlock = new Map<string, TokenTally>();
  /** Each step's latest pass, which is where a recording for that step lands. */
  const latestSpan = new Map<string, BlockSpan>();
  /** Recordings for a step that came before its first announcement. */
  const early = new Map<string, TokenTally>();

  for (const event of events) {
    if (event.kind === "step.marker" && event.mapping.confidence === "exact" && event.blockId) {
      const open = spans[spans.length - 1];
      if (open && !open.endedAt) {
        open.endedAt = event.at;
        open.durationMs = Date.parse(event.at) - Date.parse(open.startedAt);
      }
      const pass = (passesByBlock.get(event.blockId) ?? 0) + 1;
      passesByBlock.set(event.blockId, pass);
      const span: BlockSpan = { blockId: event.blockId, pass, startedAt: event.at };
      // Anything recorded for this step before it was ever announced belongs
      // to its first pass rather than to no pass, so the passes still sum.
      const before = early.get(event.blockId);
      if (before) {
        span.tokens = before;
        early.delete(event.blockId);
      }
      spans.push(span);
      latestSpan.set(event.blockId, span);
      continue;
    }

    if (event.kind === "usage" && event.tokens) {
      tokensRecorded = add(tokensRecorded, event.tokens);
      const blockId = event.mapping.confidence !== "unmapped" ? event.mapping.blockId : undefined;
      if (blockId) {
        tokensLikelyByBlock.set(blockId, add(tokensLikelyByBlock.get(blockId), event.tokens));
        const span = latestSpan.get(blockId);
        if (span) span.tokens = add(span.tokens, event.tokens);
        else early.set(blockId, add(early.get(blockId), event.tokens));
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

/**
 * The same figures over the fold's own spans.
 *
 * A recording for a step lands in the latest pass through that step that had
 * begun by then — the same rule as above, except that "latest" is judged by
 * time rather than by which step line came last, so two steps open at once
 * each keep their own. One recorded before the step's first pass belongs to
 * that first pass, so a step's passes still sum to its total.
 */
function fromFoldSpans(
  events: readonly AttributedEvent[],
  foldSpans: readonly BlockSpanView[],
  settledAt: string | undefined,
): SessionMetrics {
  const spans: BlockSpan[] = foldSpans.map((span) => {
    const end = span.endedAt ?? settledAt;
    const duration = end ? Date.parse(end) - Date.parse(span.startedAt) : NaN;
    return {
      blockId: span.blockId,
      pass: span.pass,
      startedAt: span.startedAt,
      ...(end ? { endedAt: end } : {}),
      ...(Number.isNaN(duration) ? {} : { durationMs: Math.max(0, duration) }),
    };
  });

  const passesByBlock = new Map<string, number>();
  for (const span of spans) {
    passesByBlock.set(span.blockId, Math.max(passesByBlock.get(span.blockId) ?? 0, span.pass));
  }

  let tokensRecorded: TokenTally | undefined;
  let tokensUnattributed: TokenTally | undefined;
  const tokensLikelyByBlock = new Map<string, TokenTally>();
  for (const event of events) {
    if (event.kind !== "usage" || !event.tokens) continue;
    tokensRecorded = add(tokensRecorded, event.tokens);
    const blockId = event.mapping.confidence !== "unmapped" ? event.mapping.blockId : undefined;
    if (!blockId) {
      tokensUnattributed = add(tokensUnattributed, event.tokens);
      continue;
    }
    tokensLikelyByBlock.set(blockId, add(tokensLikelyByBlock.get(blockId), event.tokens));
    const at = Date.parse(event.at);
    const own = spans.filter((span) => span.blockId === blockId);
    const begun = own.filter((span) => Date.parse(span.startedAt) <= at);
    const span = begun[begun.length - 1] ?? own[0];
    if (span) span.tokens = add(span.tokens, event.tokens);
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
