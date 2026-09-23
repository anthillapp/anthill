/**
 * The workflow's agents: a list on the left rail, an editor in the inspector.
 *
 * An agent is a reusable profile, created once and assigned to as many steps as
 * you like — which makes it a *library*, exactly like the blocks beside it, and
 * not a view of whatever happens to be selected. It used to live in the right
 * sidebar's tab group, where clicking a block on the canvas navigated away from
 * it; now the list is always on screen and clicking a row opens that profile in
 * the one inspector, where everything else is edited too.
 *
 * Nothing here runs anything. The model is the one written into the generated
 * agent file for the chosen harness; Anthill never calls it.
 */

import { useEffect, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  DEFAULT_TARGET,
  HARNESS_DEFAULT,
  addAgentProfile,
  agentProfiles,
  agentSlug,
  harnessProfile,
  modelFor,
  removeAgentProfile,
  stepsUsingAgent,
  updateAgentProfile,
  type AgentProfile,
} from "@anthill/workflow";

import type { GlobalAgentProfile } from "../../shared/ipc.js";
import {
  catalogueMissing,
  modelOptionsFor,
  retiredChoice,
  useModelCatalogues,
} from "../agents/model-catalogues.js";
import { agentFileName } from "./agent-file-name.js";

export type AgentRailProps = {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  /** The profile open in the inspector, if any. */
  selectedId?: string;
  onSelect: (agentId: string | undefined) => void;
};

/** The agent library, as a rail beside the block library. */
export function AgentRail({ workflow, onChange, selectedId, onSelect }: AgentRailProps) {
  const profiles = agentProfiles(workflow);
  const harness = harnessProfile(workflow.target ?? DEFAULT_TARGET);

  /**
   * The global library, for the agents you have already described elsewhere.
   *
   * A failure here costs the shortcut, not the rail: the workflow's own agents
   * are in the file and do not depend on this.
   */
  const [library, setLibrary] = useState<GlobalAgentProfile[]>([]);
  useEffect(() => {
    let live = true;
    void window.anthill
      .agentsList()
      .then((found) => {
        if (live) setLibrary(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const create = () => {
    const { workflow: next, agentId } = addAgentProfile(workflow, { name: "" });
    onChange(next);
    onSelect(agentId);
  };

  /**
   * Take a copy of a library profile.
   *
   * A *copy*, deliberately. The workflow is a file that has to keep meaning
   * the same thing after the library changes underneath it — or is deleted, or
   * is opened on another machine — so what it gets is its own profile with its
   * own id. `libraryId` records where the copy came from, which is what lets
   * the library say "two workflows took a copy of this" before you delete it.
   */
  const addFromLibrary = (source: GlobalAgentProfile) => {
    const { workflow: next, agentId } = addAgentProfile(workflow, {
      name: source.name,
      // The whole bag travels with the copy. Taking only this workflow's
      // target would silently discard the other tool's answer the moment
      // somebody switched the workflow's harness.
      ...(source.models ? { models: source.models } : {}),
      ...(source.modelNeedsReview ? { modelNeedsReview: source.modelNeedsReview } : {}),
      ...(source.role ? { role: source.role } : {}),
      ...(source.description ? { description: source.description } : {}),
      libraryId: source.id,
    });
    onChange(next);
    onSelect(agentId);
  };

  const taken = new Set(profiles.flatMap((profile) => (profile.libraryId ? [profile.libraryId] : [])));
  const offered = library.filter((profile) => !taken.has(profile.id));

  return (
    <div className="agent-rail">
      <p className="rail-lede">
        Who carries the work out. Assign one agent to several steps and it is the
        same agent returning to the work.
      </p>

      {/* Deliberately not `.agent-row`: `DraftClarify` draws its own agent rows
          with that name on light paper, and sharing it once already left this
          list with near-black text on a dark panel. */}
      <div className="rail-agents">
        {profiles.map((profile) => {
          const users = stepsUsingAgent(workflow, profile.id);
          return (
            <button
              key={profile.id}
              className={`rail-agent${profile.id === selectedId ? " is-selected" : ""}`}
              onClick={() => onSelect(profile.id === selectedId ? undefined : profile.id)}
            >
              <span className="rail-agent-body">
                <span className="rail-agent-name">{profile.name || "Unnamed agent"}</span>
                <span className="rail-agent-sub">
                  {[profile.role, modelFor(profile.models, harness.target)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className={`rail-agent-steps${users.length === 0 ? " is-unused" : ""}`}>
                {users.length === 0
                  ? "unused"
                  : `${users.length} step${users.length === 1 ? "" : "s"}`}
              </span>
            </button>
          );
        })}
      </div>

      {profiles.length === 0 ? (
        <p className="rail-empty">
          No agents yet. Create one, then assign it to a step.
        </p>
      ) : null}

      <button className="rail-add" onClick={create}>
        + New agent
      </button>

      {offered.length > 0 ? (
        <div className="rail-library">
          <span className="field-label">From your library</span>
          {offered.map((profile) => (
            <button
              key={profile.id}
              className="rail-library-add"
              onClick={() => addFromLibrary(profile)}
            >
              <span className="rail-agent-name">{profile.name || "Unnamed agent"}</span>
              {profile.role ? <span className="rail-agent-sub">{profile.role}</span> : null}
            </button>
          ))}
          <p className="rail-foot">
            Adds a copy this workflow owns. Editing it here does not change the library.
          </p>
        </div>
      ) : null}

      <p className="rail-foot">Each agent becomes one file next to the prompt.</p>
    </div>
  );
}

export type AgentEditorProps = {
  workflow: Workflow;
  profile: AgentProfile;
  onChange: (next: Workflow) => void;
  onSelect: (agentId: string | undefined) => void;
  onSelectStep: (nodeId: string) => void;
  /** Where the inspector came from, so there is a way back to it. */
  backTo?: { label: string; go: () => void };
};

export function AgentEditor({
  workflow,
  profile,
  onChange,
  onSelect,
  onSelectStep,
  backTo,
}: AgentEditorProps) {
  const harness = harnessProfile(workflow.target ?? DEFAULT_TARGET);
  const users = stepsUsingAgent(workflow, profile.id);
  const patch = (change: Parameters<typeof updateAgentProfile>[2]) =>
    onChange(updateAgentProfile(workflow, profile.id, change));

  /*
    The same catalogue the global library reads, by the same rules. This
    editor used to list the harness table's models, which is empty for Codex
    on purpose — Codex's are discovered on the machine — so a Codex workflow
    offered "Default" and nothing else (ANT-127).
  */
  const catalogues = useModelCatalogues();
  const options = modelOptionsFor(harness.target, catalogues);
  const missing = catalogueMissing(harness.target, catalogues);
  const chosen = profile.models?.[harness.target];
  const picked = options.find((option) => option.id === chosen?.id);
  const efforts = picked?.efforts ?? [];
  const retired = retiredChoice(chosen?.id, options, HARNESS_DEFAULT);

  /** This harness's slot only; the other tools' answers travel untouched. */
  const setModel = (next: { id: string; reasoningEffort?: string } | undefined) =>
    patch({
      models: next
        ? { ...(profile.models ?? {}), [harness.target]: next }
        : Object.fromEntries(
            Object.entries(profile.models ?? {}).filter(([key]) => key !== harness.target),
          ),
    });

  /*
    `tab-body` is the inspector's scroll region, and every other inspector uses
    it. This one did not: it rendered its root straight into the panel's
    column, which meant no side padding — the name and role inputs ran to the
    window's own edge and were clipped there — and no scrolling, so a profile
    with several steps pushed Delete past the bottom with no way to reach it.
  */
  return (
    <div className="tab-body agent-editor">
      {backTo ? (
        // Sticky, so the way back does not scroll out of reach on a long form.
        <button className="link back-link" onClick={backTo.go}>
          ← Back to {backTo.label}
        </button>
      ) : null}
      <h3>{profile.name || "Unnamed agent"}</h3>

      <label className="field">
        <span>Name</span>
        <input
          value={profile.name}
          placeholder="e.g. Developer"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </label>
      <p className="hint">
        Renaming is safe — steps point at this agent by an id that never
        changes, so nothing comes unstuck.
      </p>

      <div className="two-up">
        <label className="field">
          <span>Model</span>
          {/* This workflow's own harness, and only it: inside a workflow there
              is one target being compiled for, so the rail edits that slot and
              leaves the other harness's choice — if the agent has one — alone.
              An empty selection is a real answer here, "this harness's own
              default", which is why it is stored rather than cleared. */}
          <select
            value={chosen?.id ?? ""}
            onChange={(event) => setModel(event.target.value ? { id: event.target.value } : undefined)}
            disabled={!harness.supportsPerAgentModel}
          >
            <option value="">Default ({harness.defaultModel})</option>
            {/* So the field shows what is stored rather than appearing to
                have been set to something else. */}
            {retired ? <option value={retired}>{retired} — no longer offered</option> : null}
            {options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {model.hint ? ` — ${model.hint}` : ""}
              </option>
            ))}
          </select>
        </label>

        {/* Only where the tool has the concept, and only for a model that
            supports it: the catalogue says which levels each model offers,
            so the list is that model's rather than a fixed one. */}
        {harness.supportsReasoningEffort && picked && efforts.length > 0 ? (
          <label className="field">
            <span>Reasoning effort</span>
            <select
              value={chosen?.reasoningEffort ?? HARNESS_DEFAULT}
              onChange={(event) =>
                setModel({
                  id: picked.id,
                  ...(event.target.value === HARNESS_DEFAULT
                    ? {}
                    : { reasoningEffort: event.target.value }),
                })
              }
            >
              <option value={HARNESS_DEFAULT}>
                Inherit{picked.defaultEffort ? ` (${picked.defaultEffort})` : ""}
              </option>
              {efforts.map((effort) => (
                <option key={effort.id} value={effort.id}>
                  {effort.id}
                  {effort.hint ? ` — ${effort.hint}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>Role — optional</span>
          <input
            value={profile.role ?? ""}
            placeholder="e.g. Backend implementation"
            onChange={(event) => patch({ role: event.target.value || undefined })}
          />
        </label>
      </div>

      {!harness.supportsPerAgentModel ? (
        <p className="hint warn">
          {harness.displayName} has no per-agent model selection, so this is
          ignored.
        </p>
      ) : null}

      {retired ? (
        <p className="hint warn">
          {harness.displayName} no longer offers <code>{retired}</code>. It is still what this
          agent says, so choose again when you are ready.
        </p>
      ) : null}

      {/* Not reported as "no models": a list nobody handed over is not a list
          that is empty. Codex's catalogue is a cache the CLI refreshes when it
          runs, so opening it once is the retry; pi's is read live when the
          window loads, so the retry is a reload. */}
      {missing && harness.supportsPerAgentModel ? (
        <p className="hint warn">
          Anthill has not been given {harness.displayName}&rsquo;s model list, so only Default
          can be offered.{" "}
          {harness.target === "pi"
            ? "Check again when the window reloads."
            : `Open ${harness.displayName} once and check again.`}
        </p>
      ) : null}

      <label className="field">
        <span>Description — optional</span>
        <textarea
          rows={3}
          value={profile.description ?? ""}
          placeholder="Who this agent is and how it should approach the work"
          onChange={(event) => patch({ description: event.target.value || undefined })}
        />
      </label>

      {harness.agentDir ? (
        <p className="hint">
          Generated as <code>{agentFileName(harness, profile)}</code>
          {users.length > 1
            ? ` — one file covering all ${users.length} of its steps.`
            : "."}
        </p>
      ) : null}

      <span className="field-label">Used by</span>
      {users.length === 0 ? (
        <p className="hint">
          No step uses this agent yet. Assign it in a step's Block tab.
        </p>
      ) : (
        <div className="agent-uses">
          {users.map((node) => (
            <button key={node.id} className="link" onClick={() => onSelectStep(node.id)}>
              {node.name || "Untitled step"}
            </button>
          ))}
        </div>
      )}

      <span className="field-label">Settings</span>
      <p className="hint">
        Permissions, tool access and MCP servers will live here once Anthill can
        run a workflow. There is nothing to set yet, and nothing here is sent
        anywhere — Anthill writes workflows, it does not run them.
      </p>

      <div className="row">
        <button
          disabled={users.length > 0}
          title={
            users.length > 0
              ? `Reassign the ${users.length} step${
                  users.length === 1 ? "" : "s"
                } using this agent first.`
              : undefined
          }
          onClick={() => {
            onChange(removeAgentProfile(workflow, profile.id));
            onSelect(undefined);
          }}
        >
          Delete agent
        </button>
      </div>
      {users.length > 0 ? (
        <p className="hint warn">
          This agent cannot be deleted while {users.length} step
          {users.length === 1 ? "" : "s"} still use{users.length === 1 ? "s" : ""}{" "}
          it. Point {users.length === 1 ? "it" : "them"} at another agent first.
        </p>
      ) : null}
    </div>
  );
}
