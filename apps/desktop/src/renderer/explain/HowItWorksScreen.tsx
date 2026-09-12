/**
 * "How Anthill works" — the one screen that answers the three first-run
 * questions and stops: what do I build here, what do I do with it, and what do
 * I get back?
 *
 * It is also the one place the product's boundary can be stated plainly rather
 * than as a caveat in the corner of a working screen. **Anthill does not run
 * the session.** The whole screen is shaped around leaving that unmistakable,
 * which is why the second scene ends at "you start it" and the third shows a
 * step Anthill could not draw a conclusion about.
 *
 * The split is the launch window's own 52%, with the canvas ground and its
 * dotted grid: this screen sits at the same level of the app as the launcher,
 * not inside a workflow, and reusing the split says so before a word is read.
 *
 * No auto-advance. The reader is reading body copy beside the illustration,
 * and a carousel that moves under them takes away the control it appears to
 * offer.
 */

import { useState } from "react";

import { AnthillMark } from "../AnthillMark.js";

import { EXPLAIN_STEPS } from "./steps.js";
import { DesignScene } from "./scenes/DesignScene.js";
import { HandoverScene } from "./scenes/HandoverScene.js";
import { WatchScene } from "./scenes/WatchScene.js";

export type HowItWorksScreenProps = {
  onBack: () => void;
  onCreate: () => void;
};

const SCENES = [DesignScene, HandoverScene, WatchScene];

export function HowItWorksScreen({ onBack, onCreate }: HowItWorksScreenProps) {
  /** The whole screen's state. No timers, no scene state, nothing persisted. */
  const [step, setStep] = useState(0);
  const Scene = SCENES[step];

  return (
    <div className="how-screen">
      <div className="how-stage">
        <div className="how-back">
          <button type="button" className="icon-button" onClick={onBack} title="Back" aria-label="Back">
            ←
          </button>
          <AnthillMark size={18} />
        </div>

        {/*
          Fixed 400×290, and the scenes are hand-placed inside it — the
          coordinates assume that box, so it must not scale.

          The key is the step, so each scene mounts fresh when the step
          changes: the entrances replay on every switch without any JS.
        */}
        <div className="how-scene">
          <Scene key={step} />
        </div>

        <div className="how-dots" role="group" aria-label="Choose a step">
          {EXPLAIN_STEPS.map((item, index) => (
            <button
              key={item.title}
              type="button"
              className="how-dot"
              aria-label={`Step ${index + 1}: ${item.title}`}
              {...(index === step ? { "aria-current": "step" as const } : {})}
              onClick={() => setStep(index)}
            />
          ))}
        </div>
      </div>

      <div className="how-copy">
        <div className="how-copy-inner">
          <div>
            <h1 className="how-title">Anthill plans the work. You run it.</h1>
            <p className="how-lede">
              You design a workflow here — the steps, who carries each one out, and what
              happens when work comes back. Anthill compiles it into a prompt you paste into
              Claude Code, Codex, or Pi yourself, then watches what that session writes on this
              machine and shows you where it got to.
            </p>

            <div className="how-steps">
              {EXPLAIN_STEPS.map((item, index) => (
                <button
                  key={item.title}
                  type="button"
                  className="how-step"
                  {...(index === step ? { "aria-current": "step" as const } : {})}
                  onClick={() => setStep(index)}
                >
                  <span className="how-step-no">{index + 1}</span>
                  <span className="how-step-text">
                    <span className="how-step-title">{item.title}</span>
                    <span className="how-step-body">{item.body}</span>
                  </span>
                </button>
              ))}
            </div>

            {/* Neutral, not red: this is how the product works, not a warning. */}
            <section className="how-boundary">
              <h2>What Anthill does not do</h2>
              <p>
                It never starts, stops, answers or steers an agent. It has no terminal and no
                model of its own. Everything it shows you is read from records the CLI already
                writes on this machine — never its private reasoning, and never anything sent
                anywhere.
              </p>
              {/* The sentence most likely to be cut as redundant, and the most
                  important one here: it is what stops a reader believing
                  Anthill enforces the diagram they just drew. */}
              <p>
                Which means a workflow is a set of instructions for whoever reads it. The
                order, the conditions and the limits are things Anthill asks for — not things
                it can enforce.
              </p>
            </section>

            <div className="how-actions">
              <button type="button" className="primary" onClick={onCreate}>
                Create a workflow
              </button>
              <button type="button" onClick={onBack}>
                Back
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default HowItWorksScreen;
