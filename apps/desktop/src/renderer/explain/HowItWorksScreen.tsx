/**
 * "How Anthill works" — the two ways in, and what each looks like.
 *
 * It used to walk three steps of one path: design here, copy a prompt, watch.
 * Since the plugin, most work reaches Anthill the other way round — a session
 * hands the workflow over — so the screen now offers the two paths side by
 * side and lets the reader pick one to see it. The coding-session path is
 * first and marked Recommended because it is the shorter one for anyone who
 * already works in Claude Code or Codex; designing here stays a full path, not
 * a fallback.
 *
 * The left pane is the launch window's own 52% split on the canvas's dotted
 * ground, and it draws the path selected on the right: the live workflow under
 * a session's prompt, or the same three steps being designed with the prompt
 * that gets copied out. Nothing moves on its own; choosing a card is the only
 * thing that changes it.
 *
 * The boundary is said once, plainly, under the cards: Anthill shows and
 * follows the work, and the agent runs it.
 */

import { useState } from "react";

import { AnthillMark } from "../AnthillMark.js";
import { UnsupportedWindowsChip } from "../windows/unsupported-windows.js";

import { DesignScene } from "./scenes/DesignScene.js";
import { WatchScene } from "./scenes/WatchScene.js";

export type HowItWorksScreenProps = {
  onBack: () => void;
  /** Design in Anthill: start a new workflow. */
  onCreate: () => void;
  /** Start in your coding session: how to set up and use the plugin. */
  onFromSession: () => void;
};

type Path = "session" | "design";

export function HowItWorksScreen({ onBack, onCreate, onFromSession }: HowItWorksScreenProps) {
  /** The whole screen's state. No timers, nothing persisted. */
  const [path, setPath] = useState<Path>("session");

  return (
    <div className="how-screen">
      <div className="how-stage">
        <div className="how-back">
          <button type="button" className="icon-button" onClick={onBack} title="Back" aria-label="Back">
            ←
          </button>
          <AnthillMark size={18} />
        </div>
        <div className="win-chip-corner">
          <UnsupportedWindowsChip skin="on-light" />
        </div>

        <div className="how-slot">
          {path === "session" ? (
            <div className="how-prompt" aria-hidden="true">
              <span className="dim">&gt;&nbsp;</span>Checkout flow… <b>/anthill:workflow</b> design workflow
            </div>
          ) : (
            <span className="how-caption">Design on the canvas</span>
          )}
        </div>

        {/* Fixed 400×290, and the scenes are hand-placed inside it. The key is
            the path, so a scene mounts fresh and its entrance replays. */}
        <div className="how-scene">{path === "session" ? <WatchScene key="session" /> : <DesignScene key="design" />}</div>

        <div className="how-slot is-below">
          {path === "session" ? (
            <span className="how-caption">Anthill follows the work</span>
          ) : (
            <div className="how-copybar" aria-hidden="true">
              <span className="chip">Copy prompt</span>
              <span>→ paste into Claude Code, Codex or Pi</span>
            </div>
          )}
        </div>
      </div>

      <div className="how-copy">
        <div className="how-copy-inner">
          <div>
            <h1 className="how-title">See the plan. Follow the work.</h1>
            <p className="how-lede">
              Start in Claude Code or Codex with the Anthill plugin, or design a workflow here and
              copy the prompt into your coding tool. Your agent does the work; Anthill shows the
              workflow and its progress.
            </p>

            <div className="how-paths">
              <PathCard
                current={path === "session"}
                onPick={() => setPath("session")}
                title="Start in your coding session"
                tag="Recommended"
                recommended
                body="Describe the task in Claude Code or Codex. The plugin hands the workflow to Anthill – review the plan first, or follow the work as it happens."
                action="Set up the plugin"
                primary
                onAction={onFromSession}
              />
              <PathCard
                current={path === "design"}
                onPick={() => setPath("design")}
                title="Design in Anthill"
                tag="Copy Prompt"
                body="Build and edit the workflow on the canvas, copy the finished prompt and paste it into your tool. Works with Claude Code, Codex and Pi."
                action="Create a workflow"
                onAction={onCreate}
              />
            </div>

            <p className="how-foot">
              Anthill shows the workflow and follows progress. Your coding agent runs the work.
            </p>

            <div className="how-actions">
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

/**
 * One way in. The whole card chooses what the left pane shows; its button
 * goes there. Focusing the button chooses it too, so a keyboard reader sees
 * the same picture a pointer does.
 */
function PathCard({
  current,
  onPick,
  title,
  tag,
  recommended = false,
  body,
  action,
  primary = false,
  onAction,
}: {
  current: boolean;
  onPick: () => void;
  title: string;
  tag: string;
  recommended?: boolean;
  body: string;
  action: string;
  primary?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      className={`how-path${current ? " is-current" : ""}`}
      role="group"
      aria-label={title}
      {...(current ? { "aria-current": "true" as const } : {})}
      onClick={onPick}
      onFocus={onPick}
    >
      <div className="how-path-head">
        <h2>{title}</h2>
        <span className={`how-path-tag${recommended ? " is-recommended" : ""}`}>{tag}</span>
      </div>
      <p>{body}</p>
      <button
        type="button"
        className={primary ? "primary" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          onAction();
        }}
      >
        {action}
      </button>
    </div>
  );
}

export default HowItWorksScreen;
