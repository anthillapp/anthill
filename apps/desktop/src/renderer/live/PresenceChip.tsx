/**
 * The one thing that says a session is there.
 *
 * Three surfaces show this chip — the workflow canvas, the Live Session
 * topbar, and the announcement dialog — and they show the same one on purpose.
 * Earlier passes drew the live claim as a border around the whole workspace,
 * then as a spinning ring, then as a marching dash. All of them made a reading
 * of a log file feel like a connection to a process. A pill in a corner is the
 * honest size for what Anthill actually knows.
 *
 * The plaque beside it is separate, and appears only when there is something
 * to explain. It is anchored in the canvas's own coordinates rather than
 * inside the graph layer: put inside, it drifts away under pan and shrinks
 * under zoom, which is wrong for a statement about the session rather than
 * about the diagram.
 */

import type { PendingRun } from "@anthill/live";

import { INTERPRETER_LOGOS } from "../workflow/interpreter-logos.js";
import {
  needsPlaque,
  presenceLabel,
  presenceMoves,
  presenceStyle,
  type PresenceKey,
} from "./presence.js";

export type PresenceChipProps = {
  run: PendingRun;
  presence: PresenceKey;
  /** Given when the chip opens something. Without it the chip is not a button. */
  onClick?: () => void;
  /** Smaller, for the announcement dialog's header. */
  size?: "normal" | "small";
  /** Hidden when the surrounding page already says it. */
  showLabel?: boolean;
  title?: string;
};

export function PresenceChip({
  run,
  presence,
  onClick,
  size = "normal",
  showLabel = true,
  title,
}: PresenceChipProps) {
  const style = presenceStyle(presence);
  const moves = presenceMoves(presence);
  const named = presence !== "pending" && presence !== "stopped";

  const inner = (
    <>
      <span
        className={`presence-ring${moves ? " chip-breathe" : ""}`}
        style={{ borderColor: style.tone }}
        aria-hidden="true"
      />
      <span className="presence-body">
        <i
          className={`presence-dot dot-${style.dot}${moves ? " live-pulse" : ""}`}
          style={{ color: style.tone }}
          aria-hidden="true"
        />
        {named ? (
          <img src={INTERPRETER_LOGOS[run.selectedCli]} alt="" width={14} height={14} />
        ) : null}
        {showLabel ? (
          <span className="presence-label">{presenceLabel(run, presence)}</span>
        ) : null}
      </span>
    </>
  );

  const className = `presence-chip size-${size}`;
  if (!onClick) {
    return (
      <span className={className} title={title ?? style.note}>
        {inner}
      </span>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} title={title ?? style.note}>
      {inner}
    </button>
  );
}

export type PresencePlaqueProps = { presence: PresenceKey; note?: string };

/**
 * The half-sentence beside the chip, when the state is not plainly live.
 *
 * The handoff has this carry `label · note`. It does not, and deliberately:
 * the plaque always sits immediately beside a chip that has just said the
 * label, so repeating it is two-thirds of the plaque's width spent on a word
 * the reader has already read. The note is the part the chip cannot say.
 *
 * `note` overrides the table's wording so a caller that knows the real
 * duration can say it — "quiet for 2m" rather than "quiet for a moment".
 */
export function PresencePlaque({ presence, note }: PresencePlaqueProps) {
  if (!needsPlaque(presence)) return null;
  const style = presenceStyle(presence);
  return (
    <span className="presence-plaque" style={{ borderColor: style.tone, color: style.noteInk }}>
      {note ?? style.note}
    </span>
  );
}
