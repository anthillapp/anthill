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

import {
  handsBack,
  isHandback,
  stoppedWithSession,
  subagentStops,
  type AttributedEvent,
  type MappingConfidence,
  type ObservationEvent,
} from "@anthill/live";

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
  /**
   * The call that started the subagent this came from, when it came from one.
   *
   * What ties a delegate's tool calls and messages to the subagent that made
   * them, so the feed can say who acted rather than only what happened.
   */
  parentToolUseId?: string;
  /** The session the action happened in, so a turn ending closes only its own. */
  sessionId?: string;
  /** The raw event kinds folded into this card, in order. */
  events: string[];
  /**
   * A subagent sent off on its own: its launch receipt comes back at once and
   * is not the subagent finishing — its own turn ending is (ANT-173).
   */
  background?: boolean;
};

const AGENT_KINDS = new Set(["subagent.start", "subagent.end"]);

/** The title the Claude Code observer gives a stop the person made. */
const STOPPED_BY_HAND = "Stopped by hand";
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
  /** Agent cards by the call that started them, open or closed. */
  const dispatched = new Map<string, FeedCard>();
  /** The subagent whose own turn ended last, and when: what a SubagentStop names. */
  let lastDelegateEnd: { card: FeedCard; at: number } | undefined;
  /** A subagent's stop that is the session's own reaching it (ANT-241). */
  const cutOff = stoppedWithSession(events);
  /** Whose end each SubagentStop is: a subagent's, or Claude Code's own helper's (ANT-242, ANT-245). */
  const stopOf = subagentStops(events);
  /**
   * Where subagents hand back, a background one's turn ending or its
   * SubagentStop finishes its card only once it has: before that it stopped
   * to wait on work of its own (ANT-245).
   */
  const explicitHandback = handsBack(events);
  const handedBack = new Set<string>();
  const ends = (call: string) => !explicitHandback || handedBack.has(call);

  /** Another channel's record of this card's action, folded in rather than drawn twice. */
  const fold = (card: FeedCard, event: AttributedEvent) => {
    card.events.push(event.kind);
    for (const channel of [event.channel, ...(event.alsoFrom ?? [])]) {
      if (!card.channels.includes(channel)) card.channels.push(channel);
    }
  };

  for (const event of events) {
    // Usage is metadata about things that happened, not a thing that happened.
    // It lives in the journal for the metrics fold; a card per turn saying
    // "tokens were spent" would drown the feed in bookkeeping.
    if (event.kind === "usage") continue;
    const kind = kindOf(event);
    const pairKey = event.toolUseId;

    /*
      The agent ended its turn, so the calls it made in that turn are over.

      A card stayed "Running…" until an end paired with it, and one that never
      paired said so for the rest of the session — the ANT-45 report showed
      seven Bash commands "running" at once (ANT-60). Measured across 54 real
      journals: 103 of 6630 calls never paired, almost all from the hook log's
      PreToolUse with no PostToolUse, and 90 of those 103 were followed by the
      session's own turn ending. That is the evidence, rather than a guessed
      duration: the main agent does not end a turn while one of its calls is
      still out. What the card becomes is `unknown` — Anthill did not see it
      end, which is not the same as seeing it fail. It stays pairable, so an
      end that does arrive later (a background delegate's call, say, which can
      outlive the turn around it) still settles it as done or failed.

      Only the main agent's turn: a delegate's turn ending says nothing about
      the session's calls around it.
    */
    if (event.kind === "turn.end" && event.author?.kind !== "subagent") {
      for (const card of open.values()) {
        if (card.kind === "tool" && card.state === "working" && card.sessionId === event.sessionId) {
          card.state = "unknown";
        }
      }
    }

    // A subagent handing its result back: that is its card finished, whatever
    // its turn does next (ANT-245). The call itself still gets its own card.
    if (isHandback(event) && event.parentToolUseId) {
      handedBack.add(event.parentToolUseId);
      const card = dispatched.get(event.parentToolUseId);
      if (card?.background && open.get(event.parentToolUseId) === card) {
        card.state = "done";
        card.durationMs = Date.parse(event.at) - Date.parse(card.at);
        open.delete(event.parentToolUseId);
      }
    }

    /*
      A delegate's own turn ending, named by the call that started it. It is
      what finishes a subagent that was sent off on its own, whose launch
      receipt came back at once (ANT-173); and it is the subagent the hooks'
      SubagentStop that follows is about.
    */
    if (event.kind === "turn.end" && event.parentToolUseId) {
      const card = dispatched.get(event.parentToolUseId);
      if (card) {
        lastDelegateEnd = { card, at: Date.parse(event.at) };
        if (card.background && open.get(event.parentToolUseId) === card && ends(event.parentToolUseId)) {
          card.state = "done";
          card.durationMs = Date.parse(event.at) - Date.parse(card.at);
          open.delete(event.parentToolUseId);
        }
      }
    }

    /*
      A subagent somebody stopped: its transcript ends "[Request interrupted
      by user]", which the observer records as a stop on the call that
      started it. Stopped is not finished — the card is failed, and the hooks'
      SubagentStop right after it is the same stop, not a completion (ANT-190).
      Unless the session was stopped with it: cut off, its outcome unknown
      rather than a failure (ANT-241).
    */
    if (event.kind === "notification" && event.parentToolUseId && event.title === STOPPED_BY_HAND) {
      const card = dispatched.get(event.parentToolUseId);
      if (card) {
        const withSession = cutOff(event);
        card.state = withSession ? "unknown" : "failed";
        card.detail = withSession ? "Stopped with the session before it handed back" : "Stopped by hand before it handed back";
        card.durationMs = Date.parse(event.at) - Date.parse(card.at);
        open.delete(event.parentToolUseId);
        lastDelegateEnd = { card, at: Date.parse(event.at) };
        fold(card, event);
        continue;
      }
    }

    // A SubagentStop that names its subagent: that subagent's card, which it
    // finishes if nothing else had (ANT-245).
    const stop = event.kind === "subagent.end" ? stopOf(event) : undefined;
    const stopped = stop && typeof stop === "object" ? dispatched.get(stop.call) : undefined;
    if (stop && typeof stop === "object" && stopped) {
      if (stopped.background && open.get(stop.call) === stopped && ends(stop.call)) {
        stopped.state = "done";
        stopped.durationMs = Date.parse(event.at) - Date.parse(stopped.at);
        open.delete(stop.call);
      }
      lastDelegateEnd = { card: stopped, at: Date.parse(event.at) };
      fold(stopped, event);
      continue;
    }

    // The hooks' "a subagent finished", which names no call: the subagent
    // whose turn ended a moment ago. Folded into its card rather than drawn
    // as a second, finished one beside it (ANT-173).
    if (event.kind === "subagent.end" && !pairKey && lastDelegateEnd && Date.parse(event.at) - lastDelegateEnd.at <= 5_000) {
      fold(lastDelegateEnd.card, event);
      continue;
    }

    // A SubagentStop that is Claude Code's own helper ending after the
    // session's turn: no subagent the session started finished, and drawing
    // it as a completed one beside writers still at work said one had
    // (ANT-242).
    if (stop === "helper") continue;

    // The same call opened twice — the transcript's dispatch and the hooks'
    // PreToolUse for it. One card, not two; and the second used to take the
    // pairing key from the first, which then never closed (ANT-173).
    if (isOpening(event) && pairKey && open.has(pairKey)) {
      const card = open.get(pairKey) as FeedCard;
      if (event.kind === "subagent.start" && card.kind !== "agent") {
        card.kind = "agent";
        card.title = event.title;
        if (event.agentName) card.agentName = event.agentName;
        if (event.detail) card.detail = event.detail;
        dispatched.set(pairKey, card);
      }
      if (event.background) card.background = true;
      fold(card, event);
      continue;
    }

    if (isClosing(event) && pairKey) {
      const card = open.get(pairKey);
      // A background subagent's launch receipt: it is still at work.
      if (card && card.kind === "agent" && (card.background || event.background)) {
        card.background = true;
        fold(card, event);
        continue;
      }
      // The same receipt read from the transcript after the hooks' end had
      // already closed the card: only the transcript says the subagent was
      // sent off on its own, and it is not finished (ANT-173).
      const closed = dispatched.get(pairKey);
      if (!card && event.background && closed && closed.state === "done" && open.get(pairKey) === undefined) {
        closed.state = "working";
        closed.background = true;
        delete closed.durationMs;
        open.set(pairKey, closed);
        fold(closed, event);
        continue;
      }
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
      ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      events: [event.kind],
    };

    if (event.background) card.background = true;
    // A session-level record is a moment, not a span, so it never sits open.
    if (isOpening(event) && pairKey) open.set(pairKey, card);
    if (event.kind === "subagent.start" && pairKey) dispatched.set(pairKey, card);
    cards.push(card);
  }

  if (settled) {
    for (const card of open.values()) card.state = "unknown";
  }
  return cards;
}

/**
 * The filter chips: All, Messages and Tools.
 *
 * `unmapped` has no chip of its own. The session report's "not tied to a
 * step" count opens the feed on it, and the panel shows it as a fourth chip
 * only while it is the one in force, so the reader can see why the list is
 * short and leave it.
 */
export type FeedFilter = "all" | "message" | "tool" | "unmapped";

export const FEED_FILTERS: { key: FeedFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "message", label: "Messages" },
  { key: "tool", label: "Tools" },
];

export const UNMAPPED_FILTER = { key: "unmapped", label: "Not tied to a step" } as const;

/**
 * Whether a card passes a filter.
 *
 * Messages takes a subagent being started as well: handing a subagent its
 * task is something said, not a tool's outcome, and the feed draws it as a
 * bubble beside the other things said.
 */
export function matchesFilter(card: FeedCard, filter: FeedFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unmapped") return card.confidence === "unmapped";
  if (filter === "message") return card.kind === "message" || card.kind === "agent";
  return card.kind === filter;
}

/**
 * Who acted: the session's own agent, or a subagent it started.
 *
 * The orchestrator watches every step at once, so it is never tied to one
 * block however its record was mapped; a subagent works inside one.
 */
export type Speaker = { kind: "orchestrator" } | { kind: "agent"; name: string };

/**
 * Who each card is from, by card id.
 *
 * Only what the record says. A subagent's start is the subagent. Anything a
 * delegate wrote carries the call that started it, and is that subagent's. A
 * message the record signed as a subagent's, with no call to follow, is a
 * subagent's under the name the record gave. Everything else is the session's
 * own agent: a tool call is never handed to whichever subagent happened to be
 * at work at the time.
 *
 * `profileOf` names the workflow's agent profile for a block, which is the
 * name the workflow gave the agent and the one the canvas shows. It wins over
 * the runtime's own word for it, which the agent card prints on its Runtime
 * line instead.
 *
 * Folded over the whole feed rather than a scoped one, so narrowing to a
 * block cannot lose the subagent a call is attributed to.
 */
export function speakersOf(
  cards: readonly FeedCard[],
  profileOf: (blockId: string | undefined) => string | undefined,
): Map<number, Speaker> {
  const agents = new Map<string, Speaker>();
  const speakers = new Map<number, Speaker>();
  for (const card of cards) {
    if (card.kind !== "agent") continue;
    const speaker: Speaker = { kind: "agent", name: profileOf(card.blockId) ?? card.agentName ?? "Subagent" };
    speakers.set(card.id, speaker);
    if (card.toolUseId) agents.set(card.toolUseId, speaker);
  }
  for (const card of cards) {
    if (card.kind === "agent") continue;
    const via = card.parentToolUseId ? agents.get(card.parentToolUseId) : undefined;
    if (via) speakers.set(card.id, via);
    else if (card.author?.kind === "subagent") {
      speakers.set(card.id, { kind: "agent", name: profileOf(card.blockId) ?? card.author.name ?? "Subagent" });
    } else speakers.set(card.id, { kind: "orchestrator" });
  }
  return speakers;
}

/**
 * A tool call's outcome in the few words its row has room for.
 *
 * A finished call shows only how long it took: the tick beside it already
 * says it finished.
 */
export function toolStatus(card: Pick<FeedCard, "state" | "durationMs">): string {
  const duration = readDuration(card.durationMs);
  switch (card.state) {
    case "working":
      return "Running";
    case "done":
      return duration || "Done";
    case "failed":
      return duration ? `Failed · ${duration}` : "Failed";
    case "unknown":
      return "No result";
  }
}

/**
 * A tool call's tooltip.
 *
 * Anthill keeps that a call ran and how it ended, never what it printed — the
 * output is where a file's contents or a credential would be — so the card
 * does not open, and its tooltip says why there is no output to see.
 */
export const OUTPUT_NOTE: Record<CardState, string> = {
  done: "Anthill records that the call ran and how it ended, not what it printed.",
  working: "Still running. Anthill records how a call ends, not what it prints.",
  failed: "The call exited with an error. Anthill records that, not what it printed.",
  unknown: "The call never reported back, so there is no output.",
};

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
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  // A session resumed the next day is a real case, and "5371m" is a number
  // nobody reads. Hours, then days, dropping the seconds that stop mattering.
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
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
