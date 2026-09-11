/**
 * Scene 2 — the prompt leaves Anthill, and a person starts the session.
 *
 * The whole scene exists for its last three words. The `Copied` pill travels
 * to the CLI window and **fades**: a pill parked on that window would read as
 * "started", which is the one thing this screen exists to deny. What stays on
 * the CLI window instead is "you start it".
 *
 * The run marker on the sheet is not decoration either — it is the thing that
 * makes scene 3 possible at all.
 */

import { useState } from "react";
import type { MarkerCli } from "@anthill/live";

import { interpreterLogo } from "../../workflow/interpreter-logos.js";

/**
 * The short name, not the harness's full one.
 *
 * This is a picture of a window, and "OPENAI CODEX CLI" set in 10px uppercase
 * does not fit across a 158px card. The full `displayName` belongs where the
 * exact identity of the tool matters — the harness picker, the handover — and
 * both names for this scene live here so the label and the mark cannot drift
 * apart.
 */
const CLI_NAME: Record<MarkerCli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

/**
 * Fixed, not random.
 *
 * A redraw must not reshuffle the ragged edge: the sheet is the same object
 * every time the reader comes back to this step.
 */
const PROMPT_LINES = [100, 82, 92, 66, 88, 74];

export function HandoverScene() {
  /**
   * How many times the pill has flown, which is what picks the window's CLI.
   *
   * The illustration cycles between two of the tools Anthill hands over to;
   * the swap rides the loop rather than the step, because the loop is what a
   * reader sitting on this step actually sees happen — and it lands at the end
   * of a flight, when the pill has faded and nothing is travelling, so the
   * window changes identity between deliveries rather than under one.
   */
  const [flights, setFlights] = useState(0);
  const cli: MarkerCli = flights % 2 === 0 ? "claude-code" : "codex";

  return (
    <div>
      <article className="ex-sheet ex-node d1">
        <span className="ex-kicker">Prompt</span>
        {PROMPT_LINES.map((width, index) => (
          <i key={`${width}-${index}`} className="ex-line" style={{ width: `${width}%` }} />
        ))}
        <span className="ex-marker">ANT-1B824FE6</span>
      </article>

      <span className="ex-copied ex-fly" onAnimationIteration={() => setFlights((flown) => flown + 1)}>
        Copied
      </span>

      <article className="ex-cli ex-node d3">
        <span className="ex-cli-head">
          <i
            className="ex-cli-logo"
            style={{ backgroundImage: `url(${interpreterLogo(cli)})` }}
            aria-hidden="true"
          />
          {CLI_NAME[cli]}
        </span>
        <i className="ex-line is-typed ex-type" />
        <i className="ex-line is-dim" style={{ width: "100%" }} />
        <i className="ex-line is-dim" style={{ width: "84%" }} />
        {/* The point of the scene. */}
        <span className="ex-cli-foot">
          <i className="ex-dot run-work live-pulse" aria-hidden="true" />
          you start it
        </span>
      </article>
    </div>
  );
}
