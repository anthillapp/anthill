/**
 * One observed thing, drawn as a card.
 *
 * A card rather than a log line because the reader's question is not "what
 * arrived when" but "what is happening, and does Anthill actually know that".
 * Every card therefore states its confidence as a word — never as a colour or
 * a position, both of which a reader has to be taught — and every card can be
 * opened to show the record it came from.
 *
 * The evidence panel is the part that makes the rest trustworthy. It names the
 * channel the record was read from, the raw event names folded into the card,
 * the tool-use id that paired a start with its end, and, in plain words, how
 * the card was tied to a workflow step. If any of that is missing, the card
 * says so instead of quietly presenting a guess as a fact.
 */

import { useState } from "react";

import {
  CARD_STATE_GLYPH,
  CARD_STATE_LABEL,
  CONFIDENCE_LABEL,
  MESSAGE_CLAMP,
  readDuration,
  type FeedCard as Card,
} from "./feed.js";
import { MessageMarkup, clampMarkup } from "./message-markup.js";

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString(undefined, { hour12: false });
}

export type FeedCardProps = {
  card: Card;
  /** The block's own name, when the card was tied to one. */
  blockName?: string;
  /**
   * The Anthill agent profile the step belongs to, when the card was tied to a
   * step that has one. The card is titled with it and the runtime's own name
   * moves to the Runtime line, so the two are never confused and neither is
   * printed twice.
   */
  agentLabel?: string;
  /** Marks the newest arrival, for the drop-in. Only ever newest-first. */
  isNew?: boolean;
};

export function FeedCardView({ card, blockName, agentLabel, isNew }: FeedCardProps) {
  const [openEvidence, setOpenEvidence] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const duration = readDuration(card.durationMs);
  const stateLabel =
    card.state === "done" && duration
      ? `${CARD_STATE_LABEL.done} · ${duration}`
      : card.state === "failed" && duration
        ? `${CARD_STATE_LABEL.failed} · ${duration}`
        : CARD_STATE_LABEL[card.state];

  const long = card.kind === "message" && (card.detail?.length ?? 0) > MESSAGE_CLAMP;
  const body =
    long && !expanded ? clampMarkup(card.detail ?? "", MESSAGE_CLAMP) : card.detail;

  return (
    <article
      className={`feed-card kind-${card.kind} state-${card.state}${isNew ? " event-new" : ""}`}
    >
      <header className="feed-card-top">
        {card.kind !== "session" && card.kind !== "message" ? (
          <span className={`feed-glyph state-${card.state}`} aria-hidden="true">
            {CARD_STATE_GLYPH[card.state]}
          </span>
        ) : null}
        <span className="feed-card-title">
          {card.kind === "agent" ? (agentLabel ?? card.title) : card.title}
        </span>
        <time className="feed-card-time">{clock(card.at)}</time>
      </header>

      {/* On its own line: in a panel this narrow the tier and the title cannot
          share one without the title being clipped to three words, and the
          tier is a sentence the reader is meant to be able to finish. */}
      <span className={`feed-confidence conf-${card.confidence}`}>
        {card.confidence === "unmapped" && blockName === undefined
          ? CONFIDENCE_LABEL.unmapped
          : `${CONFIDENCE_LABEL[card.confidence]}${blockName ? ` · ${blockName}` : ""}`}
      </span>

      {card.kind === "agent" && card.agentName ? (
        // The runtime's own word for it, never one Anthill invented.
        <p className="feed-runtime">
          Runtime: <code>{card.agentName}</code>
        </p>
      ) : null}

      {body ? (
        card.kind === "message" ? (
          // An agent's own words, with its Markdown read rather than shown.
          <div className="feed-card-body">
            <MessageMarkup text={body} />
          </div>
        ) : (
          <p className="feed-card-body">{body}</p>
        )
      ) : null}
      {long ? (
        <button type="button" className="feed-more" onClick={() => setExpanded((on) => !on)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}

      {/* A tool ran and finished, so its card reports an outcome. A message is
          not work with an outcome — "Completed" under a sentence reads as a
          claim about the sentence — so a message card carries no state line. */}
      {card.kind !== "session" && card.kind !== "message" ? (
        <p className={`feed-state state-${card.state}`}>{stateLabel}</p>
      ) : null}

      <button
        type="button"
        className="feed-evidence-toggle"
        onClick={() => setOpenEvidence((on) => !on)}
        aria-expanded={openEvidence}
      >
        {openEvidence ? "Hide evidence" : "Evidence"}
      </button>

      {openEvidence ? (
        <dl className="feed-evidence">
          <dt>Read from</dt>
          <dd>
            {/* Both, when both wrote it down. The union is what the card was
                built from, so naming one of them would be a smaller truth. */}
            <code>{card.channels.join(", ")}</code>
          </dd>
          <dt>Events</dt>
          <dd>
            <code>{card.events.join(", ")}</code>
          </dd>
          {card.toolUseId ? (
            <>
              <dt>Tool use id</dt>
              <dd>
                <code>{card.toolUseId}</code>
              </dd>
            </>
          ) : null}
          <dt>Mapping</dt>
          <dd>{card.how}</dd>
        </dl>
      ) : null}
    </article>
  );
}
