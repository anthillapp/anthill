/**
 * How one step ran, at the top of its Block tab (ANT-142, ANT-268).
 *
 * How long it took, the tokens presumed for it, and how many passes — each
 * pass on its own line when it looped. A step the session never reached says
 * exactly that instead of showing a row of zeros, which would read as a step
 * that ran and did nothing; one a running session has not reached yet says it
 * has not started, because it still may.
 */

import type { BlockRunState } from "@anthill/live";

import { readDuration } from "./feed.js";
import { compact, type BlockUsage, type PassUsage } from "./report.js";
import { RUN_STATE } from "./run-state.js";

const tokens = (value: PassUsage["tokens"]) => (value ? `~${compact(value.in + value.out)}` : undefined);

export function HowItRan({
  block,
  state,
  ended,
  events,
  onShowEvents,
}: {
  block: BlockUsage | undefined;
  state: BlockRunState;
  /** Whether the session is over, which decides what "not reached" means. */
  ended: boolean;
  /** How many feed items this step has, for the link back to them. */
  events: number;
  onShowEvents: () => void;
}) {
  const passes = block?.passes ?? [];
  const style = RUN_STATE[state];
  const name = block?.name ?? "this step";

  if (passes.length === 0) {
    return (
      <section className="how-it-ran is-empty" aria-label={`How ${name} ran`}>
        <span className="block-label">How it ran</span>
        <p className="how-it-ran-none">
          {ended
            ? "The session never reached this step, so there is nothing recorded for it."
            : "This step has not started yet, so there is nothing recorded for it."}
        </p>
      </section>
    );
  }

  const total = block?.durationMs !== undefined ? readDuration(block.durationMs) : undefined;
  const presumed = tokens(block?.tokens);
  return (
    <section
      className="how-it-ran"
      style={{ borderLeftColor: style.line }}
      aria-label={`How ${name} ran`}
    >
      <div className="how-it-ran-top">
        <span className="block-label">How it ran</span>
        <span className="how-it-ran-status" style={{ color: style.ink }}>
          {style.kicker}
        </span>
      </div>
      <div className="how-it-ran-figures">
        <div>
          <b className={total ? undefined : "is-none"}>{total ?? "no end marker"}</b>
          <span>total time</span>
        </div>
        <div>
          <b className={presumed ? undefined : "is-none"}>{presumed ?? "no data"}</b>
          <span>tokens, presumed</span>
        </div>
        <div>
          <b>{passes.length}</b>
          <span>{passes.length === 1 ? "pass" : "passes"}</span>
        </div>
      </div>
      {passes.length > 1 ? (
        <ol className="how-it-ran-passes">
          {passes.map((pass) => (
            <li key={pass.pass}>
              <span className="n">Pass {pass.pass}</span>
              <span className="t">{pass.durationMs !== undefined ? readDuration(pass.durationMs) : "no end"}</span>
              <span>{tokens(pass.tokens) ? `${tokens(pass.tokens)} tokens` : "no token data"}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="how-it-ran-foot">
        <button type="button" className="block-link" onClick={onShowEvents} disabled={events === 0}>
          {events === 0 ? "No events recorded" : `Show its ${events} event${events === 1 ? "" : "s"}`}
        </button>
        <span className="block-note">
          Time runs from this step&rsquo;s start to the next, so it can include waiting.
        </span>
      </div>
    </section>
  );
}
