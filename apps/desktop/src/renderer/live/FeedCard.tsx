/**
 * One observed thing in the Activity feed (ANT-268).
 *
 * Every item but a session divider reads the same way: who acted, what they
 * did, where, and when — `[avatar] Name verb [block] ··· time` — with only the
 * content under that line changing. The session's own agent is never tied to
 * one block, because it watches all of them, so its chip says "Orchestration
 * layer"; a subagent's chip is the block it worked in, or "No block".
 *
 * How sure Anthill is that an item belongs to its block is still stated in
 * words, on the chip's tooltip, and an item nothing tied to a step is drawn
 * with a dashed edge. Only session dividers keep the evidence rows: on every
 * other item they repeated what the header now says.
 */

import {
  CARD_STATE_GLYPH,
  CARD_STATE_LABEL,
  CONFIDENCE_LABEL,
  MESSAGE_CLAMP,
  OUTPUT_NOTE,
  readDuration,
  toolStatus,
  type FeedCard as Card,
  type Speaker,
} from "./feed.js";
import { MessageMarkup, clampMarkup } from "./message-markup.js";

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString(undefined, { hour12: false });
}

/** Lucide icons on their 24-unit grid, one per tool Anthill names. */
const TOOL_ICONS: Record<string, string[]> = {
  Read: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8"],
  Bash: ["m4 17 6-6-6-6", "M12 19h8"],
  WebFetch: [
    "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20",
    "M2 12h20",
    "M12 2a15 15 0 0 1 0 20",
    "M12 2a15 15 0 0 0 0 20",
  ],
  Edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
};
const WRENCH = [
  "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
];

function ToolIcon({ tool }: { tool: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(TOOL_ICONS[tool] ?? WRENCH).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="feed-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export type FeedCardProps = {
  card: Card;
  /** Who acted. The session's own agent when absent. */
  speaker?: Speaker;
  /** The CLI's name and mark, for the session's own agent. */
  cli: { label: string; logo: string };
  /** The block the card was tied to, and its colour on the canvas. */
  block?: { name: string; color: string };
  /** Whether the tool output, or a divider's evidence, is open. */
  open?: boolean;
  onToggle?: () => void;
  /** Whether a long message shows all of itself. */
  expanded?: boolean;
  onExpand?: () => void;
  /** Marks the newest arrival, for the drop-in. Only ever newest-first. */
  isNew?: boolean;
};

export function FeedCardView({
  card,
  speaker = { kind: "orchestrator" },
  cli,
  block,
  open = false,
  onToggle,
  expanded = false,
  onExpand,
  isNew,
}: FeedCardProps) {
  const unmapped = card.confidence === "unmapped";
  const className = `feed-card kind-${card.kind} state-${card.state}${unmapped ? " is-unmapped" : ""}${isNew ? " event-new" : ""}`;

  if (card.kind === "session") {
    // A step announcement's detail is the step's id; the reader knows the step by its name.
    const detail = block && card.detail === card.blockId ? block.name : card.detail;
    return (
      <article className={className}>
        <div className="feed-divider">
          <hr />
          <b>{card.title}</b>
          <span>
            {detail ? `${detail} · ` : ""}
            {clock(card.at)}
          </span>
          <button
            type="button"
            className="feed-evidence-toggle"
            aria-label="Evidence"
            title={open ? "Hide evidence" : "Evidence"}
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "−" : "+"}
          </button>
          <hr />
        </div>
        {open ? (
          <dl className="feed-evidence">
            <dt>Read from</dt>
            <dd>
              {/* Both, when both wrote it down. The union is what the item was
                  built from, so naming one of them would be a smaller truth. */}
              <code>{card.channels.join(", ")}</code>
            </dd>
            <dt>Events</dt>
            <dd>
              <code>{card.events.join(", ")}</code>
            </dd>
            {card.sessionId ? (
              <>
                <dt>Session</dt>
                <dd>
                  <code>{card.sessionId}</code>
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

  const orchestrator = speaker.kind === "orchestrator";
  const verb = { message: "said", tool: "called", agent: "started" }[card.kind];
  // A subagent's item with no block drops the "in": "Tester said No block"
  // would read as a quotation.
  const tied = orchestrator || block !== undefined;
  const chip = orchestrator ? "Orchestration layer" : (block?.name ?? "No block");
  const confidence =
    unmapped
      ? CONFIDENCE_LABEL.unmapped
      : `${CONFIDENCE_LABEL[card.confidence]}${block ? ` · ${block.name}` : ""}: ${card.how}`;

  return (
    <article className={className}>
      <div className="feed-row">
        {orchestrator ? (
          <i
            className="feed-avatar is-orchestrator"
            style={{ backgroundImage: cli.logo }}
            aria-hidden="true"
          />
        ) : (
          <i className="feed-avatar is-agent" aria-hidden="true">
            {speaker.name.charAt(0).toUpperCase()}
          </i>
        )}
        <div className="feed-col">
          <header className="feed-card-top">
            <span className="feed-name">{orchestrator ? cli.label : speaker.name}</span>
            <span className="feed-verb">{tied ? `${verb} in` : verb}</span>
            <span className="feed-chip" title={confidence}>
              {!orchestrator && block ? (
                <i style={{ background: block.color }} aria-hidden="true" />
              ) : null}
              {chip}
            </span>
            <time className="feed-card-time">{clock(card.at)}</time>
          </header>

          {card.kind === "message" ? (
            <MessageBubble card={card} expanded={expanded} {...(onExpand ? { onExpand } : {})} />
          ) : card.kind === "agent" ? (
            <AgentBubble card={card} />
          ) : (
            <ToolBox card={card} open={open} {...(onToggle ? { onToggle } : {})} />
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * What an agent said, on its own tint so it never reads as Anthill's words.
 *
 * Clamped at `MESSAGE_CLAMP` rather than the design's 168: a final report cut
 * that early made every message a click (ANT-30).
 */
function MessageBubble({ card, expanded, onExpand }: { card: Card; expanded: boolean; onExpand?: () => void }) {
  const text = card.detail ?? "";
  const long = text.length > MESSAGE_CLAMP;
  const body = long && !expanded ? clampMarkup(text, MESSAGE_CLAMP) : text;
  return (
    <div className="feed-bubble">
      {body ? (
        // An agent's own words, with its Markdown read rather than shown.
        <div className="feed-card-body">
          <MessageMarkup text={body} />
        </div>
      ) : (
        <p className="feed-card-body">{card.title}</p>
      )}
      {long ? (
        <button type="button" className="feed-more" onClick={onExpand}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** A subagent handed its task: what it was asked, how it went, which runtime. */
function AgentBubble({ card }: { card: Card }) {
  const duration = readDuration(card.durationMs);
  return (
    <div className={`feed-bubble is-agent state-${card.state}`}>
      <p className="feed-card-body">{card.detail ?? card.title}</p>
      <div className="feed-agent-foot">
        <span className={`feed-state state-${card.state}`}>
          <i aria-hidden="true" />
          {CARD_STATE_LABEL[card.state]}
          {duration ? ` · ${duration}` : ""}
        </span>
        {card.agentName ? (
          // The runtime's own word for it, never one Anthill invented.
          <span className="feed-runtime">Runtime: {card.agentName}</span>
        ) : (
          <span className="feed-runtime is-none">Runtime not named in the record</span>
        )}
      </div>
    </div>
  );
}

/** A tool call. Opening it shows what the call printed, when that was recorded. */
function ToolBox({ card, open, onToggle }: { card: Card; open: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      className={`feed-tool state-${card.state}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="feed-tool-row">
        <span className="feed-tool-chip">
          <ToolIcon tool={card.title} />
          <span>{card.title}</span>
        </span>
        <span className="feed-tool-task">{card.detail ?? ""}</span>
        <i className={`feed-glyph state-${card.state}`} aria-hidden="true">
          {CARD_STATE_GLYPH[card.state]}
        </i>
        <span className={`feed-state state-${card.state}`}>{toolStatus(card)}</span>
        <Chevron />
      </span>
      {open ? (
        <span className="feed-output">
          {/* Anthill records that a call happened and how it ended, not what it
              printed: the output is the part a credential or a file's contents
              would be in. */}
          <pre>No output recorded.</pre>
          <span>{OUTPUT_NOTE[card.state]}</span>
        </span>
      ) : null}
    </button>
  );
}
