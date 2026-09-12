/**
 * The profile editor, in the launch window's left pane.
 *
 * Not a modal and not a third column: choosing between profiles is most of the
 * work here, so the list has to stay visible while one is open. A dialog would
 * hide the thing being compared.
 *
 * Edits are a draft, and Save writes them. The list on the right keeps showing
 * what is stored while you type, so it stays the answer to "what have I got"
 * rather than a mirror of the form — and Save is then visibly the thing that
 * changes it.
 *
 * Which means there is a way to lose typing, and the whole design here is
 * shaped around not doing that: Save is reachable by keyboard, the button says
 * whether there is anything to press, and no exit from this pane throws a
 * draft away without asking.
 */

import { useEffect, useRef } from "react";
import { configuredHarnesses, harnessProfile, type AgentModels } from "@anthill/workflow";

import type { HarnessTarget } from "@anthill/workflow-schema";

import type {
  CodexModelCatalog,
  GlobalAgentProfile,
  PiModelCatalog,
  RecentWorkflow,
} from "../../shared/ipc.js";
import type { HarnessConnections } from "../harness/useHarnessConnections.js";
import { ConnectHarness } from "../harness/ConnectHarness.js";
import { AgentModelFields } from "./AgentModelFields.js";
import type { AgentDraft } from "./useAgentLibrary.js";

/**
 * The models a profile has actually chosen, one chip per tool.
 *
 * None at all when it has answered for none — a profile can be written long
 * before any tool is connected, and a pill saying so on every such row would
 * make the most repeated words on the screen the ones saying the least.
 *
 * The tool is each chip's tooltip rather than its text: the name alone is
 * ambiguous between two vocabularies, and the row has no room to spell it out.
 */
export function modelChips(
  models: AgentModels | undefined,
): { target: string; tool: string; label: string }[] {
  return configuredHarnesses(models).map((target) => {
    const harness = harnessProfile(target);
    const choice = models?.[target];
    const inherit = !choice?.id || choice.id === "__default__";
    return {
      target,
      tool: harness.displayName,
      // "Inherit" reads as itself rather than as a resolved name: Anthill does
      // not know what the session will pick, and naming one would be a guess
      // wearing the author's decision.
      label: inherit ? "inherit" : choice!.id,
    };
  });
}

export type AgentEditorProps = {
  /** What is stored. Only its id and provenance are read here. */
  profile: GlobalAgentProfile;
  /** What is being edited. Every field on screen comes from this. */
  draft: AgentDraft;
  usedBy: RecentWorkflow[];
  /** A profile made a moment ago: naming it is the only thing left to do. */
  justCreated: boolean;
  /** Delete has been pressed once on a profile some workflow took a copy of. */
  confirming: boolean;
  /** Whether the draft differs from what is stored. */
  dirty: boolean;
  /** Whether the last Save landed. */
  saveState: "none" | "saved" | "failed";
  /** Somebody tried to leave with unsaved edits and is being asked. */
  leaving: boolean;
  /** What this machine has, so the model area can be honest about it. */
  connections: HarnessConnections;
  /** Codex's own model catalogue, and what its installed CLI can honour. */
  codex: CodexModelCatalog | undefined;
  /** What pi listed for this machine, or undefined when the CLI was not reached. */
  pi: PiModelCatalog | undefined;
  /** Which tool's setup sheet is open, if any. */
  connecting: HarnessTarget | undefined;
  onConnect: (target: HarnessTarget | undefined) => void;
  onPatch: (change: Partial<AgentDraft>) => void;
  onSave: () => void;
  onSaveAndLeave: () => void;
  onDiscardAndLeave: () => void;
  onStay: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function AgentEditor({
  profile,
  draft,
  usedBy,
  justCreated,
  confirming,
  dirty,
  saveState,
  leaving,
  connections,
  codex,
  pi,
  connecting,
  onConnect,
  onPatch,
  onSave,
  onSaveAndLeave,
  onDiscardAndLeave,
  onStay,
  onDuplicate,
  onDelete,
  onClose,
}: AgentEditorProps) {
  const named = draft.name.trim().length > 0;

  /*
   * ⌘S, because a form with a Save button is a form people save that way.
   * Bound on the pane rather than the window so it cannot fire while the
   * editor is closed, and only while there is something to write.
   */
  const pane = useRef<HTMLDivElement>(null);
  /** The model select, so the sheet can hand focus to it when one appears. */
  const modelField = useRef<HTMLSelectElement>(null);
  /** Whatever opened the sheet, so focus can go back there if it did not. */
  const openedBy = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirty) onSave();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [dirty, onSave]);

  return (
    <div
      className="agent-editor"
      ref={pane}
      onClickCapture={(event) => {
        // Remembered at the moment of the click, because by the time the sheet
        // closes the button may no longer be the element it was.
        const target = event.target as HTMLElement;
        if (target.closest(".tool-actions")) openedBy.current = target;
      }}
    >
      <div className="agent-editor-head">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          title="Close"
          aria-label="Close the agent"
        >
          ✕
        </button>
        <span className="kicker">Agent profile</span>
        <span className="spacer" />
        {/* One line about the draft rather than the last keystroke. A failed
            write outranks "unsaved", which is true but understates it: the
            author pressed Save and it did not work, and that is the thing they
            need to know. Typing again puts it back to plain unsaved — they
            have moved on. */}
        <span className={`agent-save${saveState === "failed" ? " is-failed" : ""}`} role="status">
          {saveState === "failed"
            ? "Not saved"
            : dirty
              ? "Unsaved changes"
              : saveState === "saved"
                ? "Saved"
                : ""}
        </span>
      </div>

      <div className="agent-editor-body">
        <h2 className={`agent-editor-title${named ? "" : " is-unnamed"}`}>
          {named ? draft.name : "Unnamed agent"}
        </h2>

        <div className="agent-field">
          <label className="field-label" htmlFor="agent-name">
            Name
          </label>
          <input
            id="agent-name"
            className={`field-input${named ? "" : " needs-name"}`}
            value={draft.name}
            placeholder="e.g. Developer"
            autoFocus={justCreated}
            onChange={(event) => onPatch({ name: event.target.value })}
          />
          {/* Amber, not red: nothing is wrong, and the profile saves fine
              without a name. It is a note about how it reads in a list. */}
          <p className={`field-note${named ? "" : " needs-name"}`}>
            {named
              ? "Renaming is safe — a workflow points at this agent by an id that never changes."
              : "Until this has a name it reads as “Unnamed agent” everywhere."}
          </p>
        </div>

        <div className="agent-field">
          <label className="field-label" htmlFor="agent-role">
            Role — optional
          </label>
          <input
            id="agent-role"
            className="field-input"
            value={draft.role ?? ""}
            placeholder="e.g. Backend implementation"
            onChange={(event) => onPatch({ role: event.target.value })}
          />
        </div>

        <div className="agent-field">
          <label className="field-label" htmlFor="agent-summary">
            What it is for
          </label>
          <textarea
            id="agent-summary"
            className="field-input"
            rows={3}
            value={draft.description ?? ""}
            placeholder="Who this agent is and how it should approach the work"
            onChange={(event) => onPatch({ description: event.target.value })}
          />
          <p className="field-note">
            This is what a harness reads when a step hands work to this agent, so write it
            as an instruction rather than a label.
          </p>
        </div>

        {/* Below the words, because the words can be written before any tool
            is connected and the model cannot. Nothing above this line depends
            on what is installed. */}
        <AgentModelFields
          models={draft.models}
          needsReview={profile.modelNeedsReview}
          connections={connections}
          codex={codex}
          pi={pi}
          onConnect={onConnect}
          onChange={(models) => onPatch({ models })}
          fieldRef={modelField}
        />

        <div className="section-rule">
          <span>Used by</span>
          <i aria-hidden="true" />
        </div>
        {usedBy.length === 0 ? (
          <p className="field-note">
            No workflow has taken a copy yet. Add it from a workflow&rsquo;s Agents rail.
          </p>
        ) : (
          <>
            <div className="agent-uses">
              {usedBy.map((item) => (
                <span key={item.path} className="used-tag">
                  {item.name}
                </span>
              ))}
            </div>
            {/* The relationship, and nothing beyond it. Anthill does not track
                whether a copy has drifted from this profile, so nothing here
                may suggest it knows. */}
            <p className="field-note">
              Each holds its own copy, taken when it was added — editing this profile does
              not reach them.
            </p>
          </>
        )}

        <div className="agent-editor-actions">
          {/* Disabled when the draft and the file already agree, so the button
              is also the answer to "is there anything of mine not written?" */}
          <button type="button" className="primary" disabled={!dirty} onClick={onSave}>
            Save
          </button>
          <button type="button" onClick={onDuplicate}>
            Duplicate
          </button>
          <button
            type="button"
            className={confirming ? "danger" : "agent-delete"}
            onClick={onDelete}
          >
            {confirming ? "Delete anyway" : "Delete"}
          </button>
          <span className="spacer" />
          <span className="agent-id">Identity: {profile.id}</span>
        </div>
        {/* What deleting actually costs, which is not "it breaks". */}
        {confirming ? (
          <p className="field-note is-warn">
            {usedBy.length} workflow{usedBy.length === 1 ? "" : "s"} took a copy of{" "}
            {draft.name.trim() || "this agent"}. {usedBy.length === 1 ? "It" : "They"} keep
            working — the cop{usedBy.length === 1 ? "y is" : "ies are"} theirs — but{" "}
            {usedBy.length === 1 ? "it" : "they"} will no longer point back at anything here.
          </p>
        ) : null}
      </div>

      {/*
        Asked rather than decided. Closing, opening another profile and
        switching to Workflows all arrive here, because they are the same
        question — and while it is on screen the draft is still intact behind
        it, so every answer including "stay" is safe.
      */}
      {/* Anchored to this pane rather than the window: the unsaved profile
          stays visible behind it, which is what makes "your changes are kept"
          something the author can see instead of something they are told. */}
      {connecting ? (
        <ConnectHarness
          target={connecting}
          connection={connections.of(connecting)}
          onRecheck={() => void connections.recheck(connecting)}
          onClose={() => {
            const opened = connecting;
            onConnect(undefined);
            // Focus is handed on rather than dropped: to the model field when
            // connecting has just made one — that is what the author came for
            // — and otherwise back to the control that opened the sheet.
            queueMicrotask(() => {
              if (modelField.current) modelField.current.focus();
              else openedBy.current?.focus();
              void opened;
            });
          }}
        />
      ) : null}

      {leaving ? (
        <div className="agent-leaving" role="group" aria-label="Unsaved changes">
          <span>Unsaved changes to {draft.name.trim() || "this agent"}.</span>
          <span className="spacer" />
          <button type="button" onClick={onStay}>
            Keep editing
          </button>
          <button type="button" onClick={onDiscardAndLeave}>
            Discard
          </button>
          <button type="button" className="primary" onClick={onSaveAndLeave}>
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}
