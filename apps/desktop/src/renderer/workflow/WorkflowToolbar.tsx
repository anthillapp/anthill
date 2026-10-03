/**
 * The workflow toolbar, once a workflow can arrive from a coding session.
 *
 * Most workflows are not handovers, and for those this bar is what it has
 * always been: back, mark, the Workflow / Live session switcher, the
 * workflow's name, the save
 * indicator, the validation pill, undo/redo, Save, the tool plaque and the red
 * `Prompt`. Nothing new appears and nothing moves.
 *
 * A handover changes exactly three things, and the rest of the bar is left
 * alone:
 *
 *   - **`Prompt` exports instead of handing over.** The Hand-over mints a
 *     fresh run id and registers a *second, unrelated* run from the same
 *     workflow, so two runs would appear for one piece of work. The workflow
 *     is still worth keeping, so `Prompt` writes it out as agent files and a
 *     marker-free Prompt.md, and starts nothing (ANT-265).
 *   - **the tool plaque locks.** The exchange validates that a workflow
 *     targets the tool that handed it over, so switching saves happily and the
 *     revision silently becomes one that can never be bound. In a handover the
 *     tool and the origin are the same fact, so one control carries both: it
 *     names the source, wears the lock, and opens the original task.
 *   - **a second pill appears.** "Does the graph compile" and "where does this
 *     stand with the agent" are different questions that disagree regularly —
 *     a valid graph waiting for approval, a broken graph whose earlier
 *     revision is already running — so one pill would always be hiding one of
 *     them.
 *
 * The validation pill is `No problems` rather than `Ready`, because `Ready` now
 * means "the work may begin" a few centimetres to its left. Two facts, one
 * word, and the graph's was the one safe to rename: the handover's state words
 * are shared with the text the MCP server reads out to the agent.
 */

import { useRef, useState, type ReactNode } from "react";
import { HARNESS_PROFILES, PLUGIN_HARNESS_INFO, isPluginHarness } from "@anthill/workflow";
import { HARNESS_TARGETS, type HarnessTarget } from "@anthill/workflow-schema";
import type { Workflow } from "@anthill/workflow-schema";
import { AnthillMark } from "../AnthillMark.js";
import type { ExchangeSource } from "@anthill/workflow-exchange";
import { interpreterLogoBackground } from "./interpreter-logos.js";
import { isFailure, saveMessage, type SaveStatus } from "./save-status.js";
import { ProvenancePopover } from "./ProvenancePopover.js";
import { UnsupportedWindowsChip } from "../windows/unsupported-windows.js";
import type { HandoverModel } from "./handover.js";
import { ExportIcon } from "./ExportModal.js";

/**
 * One step of the undo history, drawn rather than typeset.
 *
 * These were the glyphs `↶ ↷`, which sat off-centre in their buttons, came
 * out at a different weight from every other icon in the bar, and changed
 * shape with the font. An SVG is the same icon everywhere.
 *
 * Unavailable it dims rather than disappears — and stays focusable, with a
 * title that says why. A control that vanishes teaches nothing: the reader
 * cannot tell whether it is gone because there is nothing to do or because
 * they misremembered it existing.
 */
function StepButton({
  direction,
  available,
  onStep,
}: {
  direction: "back" | "forward";
  available: boolean;
  onStep: () => void;
}) {
  const back = direction === "back";
  const label = back ? "Step back" : "Step forward";
  return (
    <button
      type="button"
      className="icon-button icon-btn on-dark"
      aria-label={label}
      aria-disabled={available ? undefined : true}
      title={
        available
          ? `${label} (${back ? "⌘Z" : "⇧⌘Z"})`
          : back
            ? "Nothing to undo"
            : "Nothing to redo"
      }
      onClick={() => {
        if (available) onStep();
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {back ? (
          <>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </>
        ) : (
          <>
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </>
        )}
      </svg>
    </button>
  );
}

/** Everything the bar needs about a handover, or absent when there is none. */
export type ToolbarHandover = {
  model: HandoverModel;
  source: ExchangeSource;
};

export type WorkflowToolbarProps = {
  workflow: Workflow;
  onExit: () => void;
  onRename: (name: string) => void;
  onTarget: (target: HarnessTarget) => void;
  dirty: boolean;
  saveStatus: SaveStatus;
  /**
   * The problems that block a prompt, counted once for the whole screen.
   *
   * Passed in rather than recounted here: the pill, the canvas chips and the
   * inspector each derived their own count once, and they contradicted each
   * other on screen at the same moment — `No problems` in the bar beside a red
   * `1 problem` chip on the canvas, with approval enabled.
   */
  problemCount: number;
  showProblems: boolean;
  onToggleProblems: () => void;
  problemsPill: React.RefObject<HTMLButtonElement>;
  canStepBack: boolean;
  canStepForward: boolean;
  onStep: (direction: "back" | "forward") => void;
  onSave: () => void;
  /** The title field was left or confirmed with Enter. */
  onRenameDone?: () => void;
  /** Open the Hand-over. Not offered on a handover, where a second run is not wanted. */
  onPrompt: () => void;
  /** Open the Export: what Prompt does on a handover. */
  onExport?: () => void;
  handover?: ToolbarHandover;
  /** The Workflow / Live session switcher, which stands where the screen's name was (ANT-267). */
  tabs?: ReactNode;
};

export function WorkflowToolbar(props: WorkflowToolbarProps) {
  const { workflow, handover } = props;
  const sourceButton = useRef<HTMLButtonElement>(null);
  const [showSource, setShowSource] = useState(false);
  const clean = props.problemCount === 0;
  /**
   * Only a handover blocks. An ordinary workflow is the author's own file and
   * they may save it half-finished — that is what a draft is. A handover's
   * file is the one a session reads.
   */
  const saveBlocked = props.handover !== undefined && !clean;

  return (
    <header className={`topbar wf-toolbar${handover ? " is-handover" : ""}`}>
      <button className="icon-button" onClick={props.onExit} title="Back to the launch window">
        ←
      </button>
      <AnthillMark className="logo-mark" size={18} />
      {props.tabs}

      <input
        className="title-input on-dark"
        value={workflow.name}
        onChange={(event) => props.onRename(event.target.value)}
        onBlur={() => props.onRenameDone?.()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder="Workflow name"
      />

      <span className="spacer" />

      {props.dirty ? (
        <span className="pill dirty">
          <span className="dot" /> Unsaved
        </span>
      ) : null}

      {/* Announced politely and never focused: the author is told without
          being interrupted, and the caret stays where they left it. */}
      <span
        className={`save-status${isFailure(props.saveStatus) ? " is-failed" : ""}`}
        role="status"
        aria-live="polite"
      >
        {saveMessage(props.saveStatus)}
      </span>

      {/* Clickable only when there is something to open. "No problems" is
          about the graph and says nothing about whether the work is right. */}
      {clean ? (
        <span className="wf-pill wf-pill-validation is-clean">No problems</span>
      ) : (
        <button
          className="wf-pill wf-pill-validation has-problems"
          ref={props.problemsPill}
          onClick={props.onToggleProblems}
          aria-expanded={props.showProblems}
        >
          {props.problemCount} to fix
        </button>
      )}

      {/* Only while a session is doing something with it. Readiness is the
          Save button's to say, and it says it by being blocked (ANT-116). */}
      {handover?.model.pill ? (
        <span
          className={`wf-pill wf-pill-handover is-${handover.model.pill.tone}`}
          title={handover.model.pill.title}
        >
          <i aria-hidden="true" />
          {handover.model.pill.label}
        </span>
      ) : null}

      <span className="divider" />
      {/* Beside the document actions, because that is what a step is: the
          whole workflow moving, not something inside it changing. */}
      <StepButton direction="back" available={props.canStepBack} onStep={() => props.onStep("back")} />
      <StepButton
        direction="forward"
        available={props.canStepForward}
        onStep={() => props.onStep("forward")}
      />

      {/* New and Open are gone from here (ANT-141): both leave the document
          in front of you, and the launch window — one step back — is where
          a workflow is started or opened. Undo, redo and Save act on this one. */}
      {/*
        On a handover, Save is the act — and the one thing standing between a
        broken graph and a session being handed it.

        A handed-over workflow has no other way to record a revision: nothing
        writes it on a timer, and `Save` is what the session tells the user to
        press. So blocking it while the graph does not compile means a broken
        revision is never recorded at all, and the user finds out while looking
        at the canvas rather than when their session asks for something to work
        from. The server refuses such a revision too; this is the half they can
        see, and it comes first.

        Not `disabled`: a button that cannot be clicked cannot say why. It is
        clickable, refuses, and carries the reason.
      */}
      <button
        onClick={() => {
          if (saveBlocked) return;
          props.onSave();
        }}
        aria-disabled={saveBlocked ? true : undefined}
        className={saveBlocked ? "is-blocked" : undefined}
        // On a handover, Save is the next step: saving is what the session is
        // waiting for, and Prompt there only exports.
        {...(handover ? { "data-tour": "next-step", "data-tour-kind": "save" } : {})}
        title={
          saveBlocked
            ? `${props.problemCount} ${props.problemCount === 1 ? "problem" : "problems"} in the workflow. ` +
              "Saving now would hand your session a graph it cannot follow – fix them first."
            : undefined
        }
      >
        Save
      </button>

      {/* The tool plaque: one fixed-width slot beside Prompt, locked or
          selectable, so the two states swap in place and the bar never
          shifts (ANT-265). */}
      <span className="divider" />
      {handover ? (
        /* The source and the lock are one control because they are one fact:
           this came from Claude Code and is for Claude Code. */
        <button
          type="button"
          className="tool-plaque is-locked"
          ref={sourceButton}
          aria-expanded={showSource}
          onClick={() => setShowSource((open) => !open)}
          title={`This workflow came from ${HARNESS_PROFILES[handover.source.harness].displayName} and is for ${HARNESS_PROFILES[handover.source.harness].displayName} – the harness cannot be changed, because the revision could then never be bound. Opens the original task.`}
        >
          <span
            className="logo"
            aria-hidden="true"
            style={{ backgroundImage: interpreterLogoBackground(handover.source.harness) }}
          />
          <span className="label">From {HARNESS_PROFILES[handover.source.harness].displayName}</span>
          {/* Drawn, not typed: the emoji padlock renders as a colour glyph the
              font decides, so it ignored the button's colour and weight and sat
              at a different size on every machine. */}
          <svg
            className="icon lock"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="11" width="16" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </button>
      ) : (
        /* It compiles into the prompt and decides which tool the prompt is
           written for, so it sits beside the button that hands it over. The
           select is the control, laid invisibly over the plaque. */
        <label className="tool-plaque is-selectable" title="The coding tool this prompt is written for">
          {workflow.target ? (
            <span
              className="logo"
              aria-hidden="true"
              style={{ backgroundImage: interpreterLogoBackground(workflow.target) }}
            />
          ) : null}
          <span className="label">
            {workflow.target ? `For ${HARNESS_PROFILES[workflow.target].displayName}` : "Choose a tool…"}
          </span>
          <svg
            className="icon"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          <select
            aria-label="Coding tool this prompt is for"
            value={workflow.target ?? ""}
            onChange={(event) => props.onTarget(event.target.value as HarnessTarget)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {HARNESS_TARGETS.map((target) => (
              <option key={target} value={target}>
                {HARNESS_PROFILES[target].displayName}
                {isPluginHarness(target) && PLUGIN_HARNESS_INFO[target].beta ? " (beta)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {handover ? (
        /* A handover keeps a Prompt, as an export rather than a start: it
           writes the agent files and Prompt.md so the workflow can be reused,
           and binds, starts and approves nothing. Opening the Hand-over here
           would mint a second, unrelated run for the session's work. */
        <button
          className={`primary${clean ? "" : " is-blocked"}`}
          aria-disabled={!clean}
          onClick={() => (clean ? props.onExport?.() : props.onToggleProblems())}
          title={
            clean
              ? "Export the workflow as agent files and Prompt.md, so it can be reused"
              : "Fix the problems first"
          }
        >
          <ExportIcon size={13} />
          Prompt
        </button>
      ) : (
        /* Not `disabled`: a button that cannot be clicked cannot say where to
           go instead. It looks unavailable and takes the author to the
           problems that made it so — but it never opens the handover, which
           is the pairing that matters and the one that broke once. */
        <button
          className={`primary${clean ? "" : " is-blocked"}`}
          aria-disabled={!clean}
          data-tour="next-step"
          data-tour-kind="prompt"
          onClick={() => (clean ? props.onPrompt() : props.onToggleProblems())}
          title={clean ? undefined : "Fix the problems first"}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 1.5 L10 6 L2.5 10.5 Z" fill="currentColor" />
          </svg>
          Prompt
        </button>
      )}

      {/* The unsupported-Windows chip, in the chrome and never over the canvas (ANT-154). */}
      <UnsupportedWindowsChip skin="on-dark" />

      {showSource && handover ? (
        <ProvenancePopover
          source={handover.source}
          anchor={sourceButton}
          onClose={() => setShowSource(false)}
        />
      ) : null}
    </header>
  );
}
