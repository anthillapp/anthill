/**
 * The one shape the scenes share: a workflow block, at explainer scale.
 *
 * Built from the product's own vocabulary rather than generic boxes — the same
 * card anatomy, the same category dots, the same run-state colours the canvas
 * uses. Someone who reads this screen should recognise what they are looking
 * at the first time they open a real workflow; a stylised abstraction would be
 * prettier and would teach nothing.
 *
 * It never fades. An earlier version dropped the not-reached card to 0.6
 * opacity and put its own label at about 1.5:1 — the state is already said in
 * words and in a greyed dot, which is enough.
 */

import type { ReactNode } from "react";

export type ExplainerCardProps = {
  /** Position inside the fixed 400×290 scene box. */
  at: { left: number; top: number };
  /** The colour of the square before the kicker. */
  dot: "cat-build" | "cat-verify" | "run-done" | "run-work" | "run-idle";
  /** Whether the dot breathes, for the step being worked on right now. */
  dotPulses?: boolean;
  kicker: string;
  name: string;
  /** `done`, `working`, `idle` — or nothing, when the card shows a chip. */
  state?: "done" | "working" | "idle";
  /** The agent's name, on a card that is not reporting a state. */
  chip?: string;
  /** What the state line says, when there is one. */
  says?: string;
  /** The entrance delay slot, absent on a scene that does not animate in. */
  enters?: "d1" | "d2" | "d3";
  children?: ReactNode;
};

const BORDER: Record<string, string> = {
  done: " is-done",
  working: " is-working",
  idle: " is-idle",
};

const INK: Record<string, string> = {
  done: "run-done",
  working: "run-work",
  idle: "run-idle",
};

export function ExplainerCard({
  at,
  dot,
  dotPulses = false,
  kicker,
  name,
  state,
  chip,
  says,
  enters,
  children,
}: ExplainerCardProps) {
  return (
    <div
      className={`ex-card${state ? BORDER[state] : ""}${enters ? ` ex-node ${enters}` : ""}`}
      style={{ left: at.left, top: at.top }}
    >
      <span className="ex-kicker">
        <i className={`ex-dot ${dot}${dotPulses ? " live-pulse" : ""}`} aria-hidden="true" />
        {kicker}
      </span>
      <span className="ex-name">{name}</span>
      {chip ? <span className="ex-chip">{chip}</span> : null}
      {/* The run state is text before it is anything else: `ink`, never the
          paler `rule` a border may use. */}
      {says && state ? <span className={`ex-state ${INK[state]}`}>{says}</span> : null}
      {children}
    </div>
  );
}
