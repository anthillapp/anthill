/**
 * One step of an ended session, before its events (ANT-142).
 *
 * Where it ended, how long it took, what was recorded inside it, and — when it
 * looped — each pass on its own line. A step the session never reached says
 * exactly that instead of showing a row of zeros, which would read as a step
 * that ran and did nothing. Only for an ended session: while the session runs,
 * the step's card on the graph is the live answer.
 */

import { readDuration } from "./feed.js";
import { tokenLine, type BlockUsage } from "./report.js";

const STATUS = {
  done: "Finished",
  failed: "Ended with an error",
  unknown: "Outcome unknown",
  notReached: "Not reached",
  waiting: "Waiting on you",
} as const;

export function HowItRan({ block, events }: { block: BlockUsage; events: number }) {
  const reached = block.passes.length > 0;
  return (
    <section className={`how-it-ran is-${block.outcome}`} aria-label={`How ${block.name} ran`}>
      <span className="kicker">How it ran · {STATUS[block.outcome]}</span>
      {reached ? (
        <>
          <p className="how-it-ran-total">
            {block.durationMs !== undefined ? readDuration(block.durationMs) : "no end marker"}
            {" · "}
            {tokenLine(block.tokens, true)}
            {" · "}
            {block.passes.length} pass{block.passes.length === 1 ? "" : "es"}
          </p>
          {block.passes.length > 1 ? (
            <ol className="how-it-ran-passes">
              {block.passes.map((pass) => (
                <li key={pass.pass}>
                  Pass {pass.pass} · {pass.durationMs !== undefined ? readDuration(pass.durationMs) : "no end marker"} ·{" "}
                  {tokenLine(pass.tokens, true)}
                </li>
              ))}
            </ol>
          ) : null}
          <p className="how-it-ran-note">
            {events} event{events === 1 ? "" : "s"} below. Time runs from this step&rsquo;s
            announcement to the next, so it can include waiting; ~ marks tokens presumed from the
            step that was announced when they were recorded.
          </p>
        </>
      ) : (
        <p className="how-it-ran-total">
          The session never reached this step, so there is nothing recorded for it.
        </p>
      )}
    </section>
  );
}
