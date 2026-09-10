/**
 * The activity feed, folded out of the journal.
 *
 * The journal is a list of moments; the feed is a list of *things that
 * happened*, which is not the same shape. A tool call arrives as a start and
 * later an end, and showing both as rows produces a log where every action is
 * mentioned twice and the reader has to pair them by eye. Here a start opens a
 * card and the matching end updates it, so one action is one card.
 *
 * The states a card can end in are deliberately four, not three. A tool that
 * started and never reported finishing is `unknown` — not `failed`, because
 * nothing said it failed, and not `working`, because the session is over. That
 * outcome is common (a CLI that exits mid-call writes no end record) and
 * calling it an error would be Anthill inventing a fact.
 *
 * Pure and clock-free: the same journal folds to the same feed in a test as on
 * screen.
 */

import type { AttributedEvent, MappingConfidence, ObservationEvent } from "@anthill/live";

/**
 * How many cards the feed draws.
 *
 * A bound on rendering, and on nothing else. It lived in the journal and
 * bounded what the page was given at all — which also bounded what the
 * diagram above the feed could be folded from, so a long session lost its
 * early steps (ANT-73). The graph now folds over the whole record and this
 * decides only how far back the list itself goes.
 */
export const FEED_LIMIT = 1000;

/** What the card is about, which decides how it is drawn. */
export type CardKind = "session" | "agent" | "tool" | "message";

/** How the thing the card describes turned out. */
export type CardState = "working" | "done" | "failed" | "unknown";

export type FeedCard = {
  /** Stable across updates: the opening event's seq. */
  id: number;
  kind: CardKind;
  state: CardState;
  /** When it started. */
  at: string;
  /** Tool name, agent name, or the event's own title. */
  title: string;
  /** The second line: a tool's target, a step id, the notification text. */
  detail?: string;
  /** The runtime's own name for the agent, when the record named one. */
  agentName?: string;
  /** Who wrote a message, as the record said. Absent when it did not say. */
  author?: ObservationEvent["author"];
  durationMs?: number;
  confidence: MappingConfidence;
  blockId?: string;
  /** Plain words for how it was tied to a step. Never omitted. */
  how: string;
  /**
   * Every channel this action was read from, in the order they were read.
   *
   * More than one when the same action was described twice — a hook log and a
   * transcript both record a tool call — and the card says so rather than
   * naming one and hiding the other.
   */
  channels: string[];
  toolUseId?: string;
  /** The raw event kinds folded into this card, in order. */
  events: string[];
};

const AGENT_KINDS = new Set(["subagent.start", "subagent.end"]);
const TOOL_KINDS = new Set(["tool.start", "tool.end"]);

function kindOf(event: AttributedEvent): CardKind {
  if (AGENT_KINDS.has(event.kind)) return "agent";
  if (TOOL_KINDS.has(event.kind)) return "tool";
  // What the agent said, and what the CLI said on its behalf. Only `notification`
  // used to land here, and no transcript writes one — so Messages was a filter
  // that could only ever be empty on the two CLIs Anthill actually reads.
  if (event.kind === "message" || event.kind === "notification") return "message";
  return "session";
}

/**
 * What a message card is titled: who wrote it.
 *
 * "The agent wrote" told a reader nothing they could act on — a workflow with
 * a coordinator and three specialists produced a column of identical headings.
 * A *name* therefore comes from the record or not at all, never from whichever
 * agent the graph happens to be on.
 *
 * But absence of an authorship marker is not absence of knowledge, which is
 * where this got it wrong (ANT-28). Being a subagent is the special case, and
 * it is the case the observers positively identify — `isSidechain` on Claude
 * Code. An event carrying no `author` at all is the session's own message, and
 * so is one from before `author` existed: the journal keeps 24 hours, so those
 * are ordinary current sessions rather than history, and every one of them
 * read "Unknown agent".
 *
 * The two remaining unknowns stay honestly apart. A subagent the record did
 * not name is a *subagent* whose name is unknown — calling it the main agent
 * would be a different claim, and a wrong one.
 */
export function authorLabel(author: ObservationEvent["author"]): string {
  if (!author) return "Main agent";
  if (author.kind === "main") return "Main agent";
  return author.name ?? "Subagent";
}

function isOpening(event: AttributedEvent): boolean {
  return event.kind === "tool.start" || event.kind === "subagent.start";
}

function isClosing(event: AttributedEvent): boolean {
  return event.kind === "tool.end" || event.kind === "subagent.end";
}

/**
 * Fold the journal into cards, oldest first.
 *
 * `settled` says whether the session is over. It only changes what an
 * unfinished card is called: while the session runs, a started tool is still
 * working; once it has ended, that tool's outcome is unknown and saying so is
 * the point.
 */
export function buildFeed(events: AttributedEvent[], settled: boolean): FeedCard[] {
  const cards: FeedCard[] = [];
  /** Open cards by the id that pairs a start with its end. */
  const open = new Map<string, FeedCard>();

  for (const event of events) {
    // Usage is metadata about things that happened, not a thing that happened.
    // It lives in the journal for the metrics fold; a card per turn saying
    // "tokens were spent" would drown the feed in bookkeeping.
    if (event.kind === "usage") continue;
    const kind = kindOf(event);
    const pairKey = event.toolUseId;

    if (isClosing(event) && pairKey) {
      const card = open.get(pairKey);
      if (card) {
        card.state = event.ok === false ? "failed" : "done";
        card.durationMs = event.durationMs ?? Date.parse(event.at) - Date.parse(card.at);
        card.events.push(event.kind);
        // The end may have been read somewhere the start was not.
        for (const channel of [event.channel, ...(event.alsoFrom ?? [])]) {
          if (!card.channels.includes(channel)) card.channels.push(channel);
        }
        // A closing record can name the step when the opening one could not.
        if (event.mapping.confidence !== "unmapped" && card.confidence === "unmapped") {
          card.confidence = event.mapping.confidence;
          if (event.mapping.blockId) card.blockId = event.mapping.blockId;
          card.how = event.mapping.how;
        }
        open.delete(pairKey);
        continue;
      }
      // An end with no start: the start was written before Anthill was
      // reading. It is still a thing that happened, so it gets its own card
      // rather than being dropped.
    }

    const card: FeedCard = {
      id: event.seq,
      kind,
      state: isOpening(event) ? "working" : isClosing(event) && event.ok === false ? "failed" : "done",
      at: event.at,
      // An agent card keeps the record's own title; its runtime name has its
      // own line, and printing the same word in both places reads as two facts.
      title:
        event.toolName ??
        (kind === "message"
          ? authorLabel(event.author)
          : kind === "agent"
            ? event.title
            : (event.agentName ?? event.title)),
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.agentName ? { agentName: event.agentName } : {}),
      ...(event.author ? { author: event.author } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      confidence: event.mapping.confidence,
      ...(event.mapping.blockId ? { blockId: event.mapping.blockId } : {}),
      how: event.mapping.how,
      channels: [event.channel, ...(event.alsoFrom ?? [])],
      ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
      events: [event.kind],
    };

    // A session-level record is a moment, not a span, so it never sits open.
    if (isOpening(event) && pairKey) open.set(pairKey, card);
    cards.push(card);
  }

  if (settled) {
    for (const card of open.values()) card.state = "unknown";
  }
  return cards;
}

export type FeedFilter = "all" | "message" | "tool" | "agent" | "unmapped";

export const FEED_FILTERS: { key: FeedFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "message", label: "Messages" },
  { key: "tool", label: "Tools" },
  { key: "agent", label: "Agents" },
  { key: "unmapped", label: "Unmapped" },
];

export function matchesFilter(card: FeedCard, filter: FeedFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unmapped") return card.confidence === "unmapped";
  return card.kind === filter;
}

/** Three tiers and nothing between them, always stated as a word. */
export const CONFIDENCE_LABEL: Record<MappingConfidence, string> = {
  exact: "Confirmed",
  likely: "Likely",
  unmapped: "Not mapped to a workflow step",
};

export const CARD_STATE_LABEL: Record<CardState, string> = {
  working: "Running…",
  done: "Completed",
  failed: "Failed",
  unknown: "Status unknown",
};

export const CARD_STATE_GLYPH: Record<CardState, string> = {
  working: "◌",
  done: "✓",
  failed: "×",
  unknown: "?",
};

/** A duration a person can read, or nothing when there is none to report. */
export function readDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Long text is clamped rather than truncated, so it can be opened.
 *
 * 168 cut a final report a sentence or two in, so the common case was
 * expanding every card and the clamp cost a click rather than saving a scroll
 * (ANT-30). The number is a judgement about reading, not a property: what has
 * to hold is that `clampMarkup` cuts where every opened marker is closed, and
 * that holds at any length.
 */
export const MESSAGE_CLAMP = 336;
