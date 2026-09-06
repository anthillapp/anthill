/**
 * The agent's model, per coding tool.
 *
 * Two cards, and each answers for itself, because the two tools are genuinely
 * different: Claude Code's models are declared in Anthill's own table, Codex's
 * are discovered from the catalogue Codex keeps on this machine, and Codex has
 * a reasoning effort where Claude Code has none. One picker could only have
 * served both by pretending they share a vocabulary.
 *
 * A tool's connection and an agent's model stay separate facts. Whether Codex
 * is on this machine is a fact about the machine; which model this agent uses
 * for Codex is a fact about this profile. Two things follow, and both were got
 * wrong before: "not connected" is never rendered as "no model chosen", and no
 * model list is ever shown for a tool that is not connected — a list of names
 * on a machine that has none of them is a false claim about the author's
 * computer, and any choice made from it is one Anthill could not honour.
 *
 * And the requirement above the rest: an unconnected tool always offers its
 * connect action, including while the other one is connected and working.
 *
 * Why an answer per tool rather than one: **you start the session, so the tool
 * you start decides.** An agent handed to Claude Code runs on the Claude Code
 * answer; the same agent handed to Codex runs on the Codex one. Neither is the
 * agent's "real" model, because there is no run for Anthill to have an opinion
 * about — which is exactly why the two are kept apart and never translated.
 */

import { HARNESS_DEFAULT, harnessProfile, type AgentModels } from "@anthill/workflow";
import { HARNESS_TARGETS, type HarnessTarget } from "@anthill/workflow-schema";

import type { CodexModelCatalog, CodexModelOption } from "../../shared/ipc.js";
import { INTERPRETER_LOGOS } from "../workflow/interpreter-logos.js";
import { isConnected, type HarnessConnections, type ToolStatus } from "../harness/useHarnessConnections.js";

/** What a picker carries when nobody has answered. Never stored. */
export const UNSET = "__unset__";

/**
 * The badge, in a word first.
 *
 * Colour is a second channel and never the only one — a dot alone would have to
 * be taught, and the states it would have to teach include two ambers that mean
 * different things.
 */
const BADGE: Record<ToolStatus, { word: string; tone: string }> = {
  off: { word: "Not connected", tone: "off" },
  checking: { word: "Checking…", tone: "checking" },
  on: { word: "Connected", tone: "on" },
  "not-installed": { word: "Not installed", tone: "not-installed" },
  "signed-out": { word: "Signed out", tone: "signed-out" },
  failed: { word: "Connection failed", tone: "failed" },
};

/** What is true about a tool right now, where there is something to say. */
function noteFor(status: ToolStatus, tool: string): { text: string; tone?: string } | undefined {
  switch (status) {
    case "off":
      return { text: "Not connected yet, so there is no model to choose from." };
    case "checking":
      return { text: `Looking for ${tool} on this machine…` };
    // Amber is "you can finish this". Both of these have a next step, and
    // nothing about either is broken.
    case "not-installed":
      return { text: `${tool} was not found on this machine.`, tone: "warn" };
    case "signed-out":
      return { text: `${tool} is installed but signed out.`, tone: "warn" };
    // The only red in the section.
    case "failed":
      return { text: "Anthill could not finish connecting. Nothing was changed.", tone: "error" };
    default:
      return undefined;
  }
}

export type AgentModelFieldsProps = {
  models: AgentModels | undefined;
  /** A stored answer the author still has to settle, if there is one. */
  needsReview: string | undefined;
  connections: HarnessConnections;
  /** Codex's own catalogue, or undefined when Anthill has not been told. */
  codex: CodexModelCatalog | undefined;
  onConnect: (target: HarnessTarget) => void;
  onChange: (models: AgentModels) => void;
  /** So focus can be handed to a field once connecting has made one. */
  fieldRef?: React.RefObject<HTMLSelectElement>;
};

export function AgentModelFields({
  models,
  needsReview,
  connections,
  codex,
  onConnect,
  onChange,
  fieldRef,
}: AgentModelFieldsProps) {
  const set = (target: HarnessTarget, next: { id: string; reasoningEffort?: string } | undefined) => {
    const bag: AgentModels = { ...(models ?? {}) };
    if (!next) delete bag[target];
    else bag[target] = next;
    onChange(bag);
  };

  const anyConnected = HARNESS_TARGETS.some((target) => isConnected(connections.of(target)));

  /*
   * The CLI is there and reads no custom agents, so a per-agent model cannot
   * reach it. The choice is still offered and still saved — it is right, and it
   * becomes true the moment they update — but nothing here pretends it applies.
   */
  const codexStale =
    isConnected(connections.of("codex")) && codex?.agentSupport === "unsupported";

  return (
    <>
      <div className="section-rule">
        <span>Model, per tool</span>
        <i aria-hidden="true" />
      </div>

      {/* A bare model name from before models were kept per tool, belonging to
          no tool Anthill can attribute. Shown back rather than guessed at:
          only the author knows which tool they meant it for. */}
      {needsReview ? (
        <p className="agent-models-review">
          This agent was set to <code>{needsReview}</code> before models were kept per tool,
          and that name belongs to no tool Anthill can name with certainty. Choose below and
          it will be replaced.
        </p>
      ) : null}

      {/* Explains the section, and would be noise once there is a picker. */}
      {!anyConnected ? (
        <p className="agent-models-intro">
          Connect a coding tool to choose models for this agent. One is enough to start —
          you can add the other later. This agent keeps a separate model for each, because
          you start the session yourself and the tool you start is what decides.
        </p>
      ) : null}

      <div className="agent-models" role="group" aria-label="Model per coding tool">
        {HARNESS_TARGETS.map((target) => {
          const harness = harnessProfile(target);
          const connection = connections.of(target);
          const live = isConnected(connection);
          const badge = BADGE[connection.status];
          const note = noteFor(connection.status, harness.displayName);
          const chosen = models?.[target];
          const stale = target === "codex" && live && codexStale;

          /* Declared for Claude Code, discovered for Codex. A discovered list
             Anthill has not been given is not an empty one, and the card says
             the difference rather than showing a picker with nothing in it. */
          const options: CodexModelOption[] = harness.modelsAreDeclared
            ? harness.models.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.hint ? { hint: option.hint } : {}),
                efforts: [],
              }))
            : (codex?.models ?? []);

          const picked = options.find((option) => option.id === chosen?.id);
          const efforts = picked?.efforts ?? [];
          /*
           * A stored answer this tool no longer offers — a model retired since
           * it was chosen, most often. Kept and shown rather than quietly
           * dropped or silently replaced: it is the author's decision, and a
           * picker that had reset itself to something else would be the worst
           * of the three outcomes.
           */
          const retired =
            chosen && chosen.id !== HARNESS_DEFAULT && options.length > 0 && !picked
              ? chosen.id
              : undefined;

          return (
            <div className={`tool-card${live ? " is-connected" : ""}`} key={target}>
              <div className="tool-card-top">
                <img className="tool-logo" src={INTERPRETER_LOGOS[target]} alt="" />
                {/* A `label` only where there is a field to label. Pointing one
                    at the connect button would make its accessible name the
                    tool's name, when what it does is open the connection
                    step. */}
                {live && options.length > 0 ? (
                  <label className="tool-name" htmlFor={`agent-model-${target}`}>
                    {harness.displayName}
                  </label>
                ) : (
                  <span className="tool-name">{harness.displayName}</span>
                )}
                <span className={`tool-badge is-${stale ? "signed-out" : badge.tone}`}>
                  <i aria-hidden="true" />
                  {stale ? "Update needed" : badge.word}
                </span>
              </div>

              {/*
                Amber, not red: nothing is broken and there is a next step. The
                installed CLI predates project-scoped custom agents, so the file
                Anthill writes would be read by nobody.
              */}
              {stale ? (
                <p className="tool-note is-warn">
                  Update {harness.displayName} to use custom agents. The version installed
                  here does not read <code>.codex/agents</code>, so a model chosen for it
                  will be saved but not applied — a session will run this agent on its own
                  model.
                </p>
              ) : null}

              {live && options.length > 0 ? (
                <>
                  <select
                    id={`agent-model-${target}`}
                    {...(target === "claude-code" && fieldRef ? { ref: fieldRef } : {})}
                    className="field-input"
                    aria-label={`${harness.displayName} model for this agent`}
                    value={chosen?.id ?? UNSET}
                    onChange={(event) =>
                      set(
                        target,
                        event.target.value === UNSET ? undefined : { id: event.target.value },
                      )
                    }
                  >
                    <option value={UNSET}>Not chosen</option>
                    {/* An explicit decision to take whatever the session uses,
                        which is a different answer from not having chosen. */}
                    <option value={HARNESS_DEFAULT}>Default — inherit from the session</option>
                    {/* So the field shows what is stored rather than appearing
                        to have been set to something else. */}
                    {retired ? <option value={retired}>{retired} — no longer offered</option> : null}
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                        {option.hint ? ` — ${option.hint}` : ""}
                      </option>
                    ))}
                  </select>

                  {/* Only where the tool has the concept, and only for a model
                      that supports it: Codex's catalogue says which levels each
                      model offers, so the list is that model's rather than a
                      fixed one. */}
                  {harness.supportsReasoningEffort && efforts.length > 0 ? (
                    <select
                      className="field-input"
                      aria-label={`${harness.displayName} reasoning effort for this agent`}
                      value={chosen?.reasoningEffort ?? HARNESS_DEFAULT}
                      onChange={(event) =>
                        set(target, {
                          id: chosen?.id ?? HARNESS_DEFAULT,
                          ...(event.target.value === HARNESS_DEFAULT
                            ? {}
                            : { reasoningEffort: event.target.value }),
                        })
                      }
                    >
                      <option value={HARNESS_DEFAULT}>
                        Reasoning: inherit
                        {picked?.defaultEffort ? ` (${picked.defaultEffort})` : ""}
                      </option>
                      {efforts.map((effort) => (
                        <option key={effort.id} value={effort.id}>
                          Reasoning: {effort.id}
                          {effort.hint ? ` — ${effort.hint}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  {/* What the list is and is not evidence of. Codex records
                      what it last listed for this machine — better than "what
                      this version supports" — but it is a cache with a date,
                      not a live check of the account. */}
                  {!harness.modelsAreDeclared && codex?.fetchedAt ? (
                    <p className="tool-note">
                      The models {harness.displayName} last listed for you, on{" "}
                      {new Date(codex.fetchedAt).toLocaleDateString()}.
                    </p>
                  ) : null}
                </>
              ) : null}

              {retired ? (
                <p className="tool-note is-warn">
                  {harness.displayName} no longer offers <code>{retired}</code>. It is still
                  what this agent says, so choose again when you are ready.
                </p>
              ) : null}

              {/* Connected, and Anthill has not been given its catalogue. Not
                  reported as "no models": a list nobody handed over is not a
                  list that is empty. */}
              {live && options.length === 0 ? (
                <p className="tool-note">
                  {harness.displayName} is connected, but Anthill has not been given its model
                  list, so there is nothing to choose from yet. Open {harness.displayName}{" "}
                  once and check again.
                </p>
              ) : null}

              {note ? (
                <p className={`tool-note${note.tone ? ` is-${note.tone}` : ""}`}>{note.text}</p>
              ) : null}

              <div className="tool-actions">
                {live ? (
                  <button
                    type="button"
                    className="tool-review"
                    aria-expanded={false}
                    onClick={() => onConnect(target)}
                  >
                    Review connection
                  </button>
                ) : (
                  /* Always offered, whatever the other card says. A working
                     Claude Code is not a reason Codex has no way in. */
                  <button
                    type="button"
                    className={`tool-connect${connection.status === "checking" ? " is-busy" : ""}`}
                    aria-expanded={false}
                    disabled={connection.status === "checking"}
                    onClick={() => onConnect(target)}
                  >
                    {connection.status === "checking"
                      ? "Checking…"
                      : connection.status === "failed"
                        ? "Try again"
                        : connection.status === "off"
                          ? `Connect ${harness.displayName}`
                          : "Check again"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/*
        The sentence the whole per-tool shape rests on, and the one nobody can
        infer from the controls: an agent gets a model per tool because *you*
        start the session, so the tool you start is what decides. Said plainly
        rather than left to be worked out from two pickers.
      */}
      <p className="agent-models-note">
        You start the session yourself, so the tool you start decides which of these
        applies: hand this agent to Claude Code and it uses the Claude Code answer, hand it
        to Codex and it uses the Codex one. Leaving one unchosen is fine — that tool falls
        back to its own default, the workflow will say so when it needs it, and neither
        answer is ever borrowed for the other.
      </p>
    </>
  );
}
