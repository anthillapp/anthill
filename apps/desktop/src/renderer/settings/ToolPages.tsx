/**
 * The three Settings pages about coding tools (ANT-135): which tools are
 * connected, which models a workflow can use, and whether Anthill's plugin is
 * installed in each.
 *
 * None of them detects anything of its own. Connections come from
 * `useHarnessConnections`, models from `useModelCatalogues`, hooks from the
 * Live observation status — the same sources the editors and the other pages
 * read — so Settings and the editor never disagree about the same machine.
 *
 * And none of them changes another program. Connecting hands over to the CLI's
 * own login; the plugin page reports and shows the commands, and running them
 * is the author's. The only thing written from here is Anthill's own model
 * preferences file.
 */

import { Fragment, useCallback, useEffect, useState } from "react";

import {
  HARNESS_DEFAULT,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  INTERPRETER_IDS,
  harnessProfile,
  type HarnessModelChoice,
  type InterpreterId,
  type ModelPreferences,
  type ModelTierId,
} from "@anthill/workflow";
import type { HarnessTarget } from "@anthill/workflow-schema";

import type { ObservationSetupStatus, PluginHarnessStatus, PluginStatus } from "../../shared/ipc.js";
import { BADGE } from "../agents/AgentModelFields.js";
import {
  catalogueMissing,
  modelOptionsFor,
  useModelCatalogues,
  type ModelCatalogues,
} from "../agents/model-catalogues.js";
import { useModelPreferences } from "../agents/useModelPreferences.js";
import { ConnectHarness } from "../harness/ConnectHarness.js";
import { isConnected, useHarnessConnections, type HarnessConnection } from "../harness/useHarnessConnections.js";
import { interpreterLogo } from "../workflow/interpreter-logos.js";
import { CHIP, hookState } from "./hook-state.js";
import { pluginSteps, pluginVerdict, serverSteps, type PluginStep, type PluginVerdict } from "./plugin-steps.js";
import { SettingDivider, SettingGroup, SettingRow, SettingSwitch, StateChip } from "./SettingRow.js";

/** The badge's tone, in the three tones a Settings chip has. */
function chipTone(connection: HarnessConnection): "on" | "quiet" | "off" {
  if (connection.status === "on") return "on";
  if (connection.status === "off" || connection.status === "checking") return "off";
  return "quiet";
}

/** The button a tool's row offers, in the words the agent editor's card uses. */
function connectLabel(connection: HarnessConnection, name: string): string {
  switch (connection.status) {
    case "on":
      return "Review connection";
    case "checking":
      return "Checking…";
    case "failed":
      return "Try again";
    case "off":
      return `Connect ${name}`;
    default:
      return "Check again";
  }
}

/* ------------------------------------------------------------------ */
/* Coding tools                                                        */
/* ------------------------------------------------------------------ */

export function CodingToolsPage() {
  const connections = useHarnessConnections();
  const [connecting, setConnecting] = useState<InterpreterId | undefined>();
  const [hooks, setHooks] = useState<ObservationSetupStatus | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => window.anthill.liveSetupStatus(undefined, true))
      .then((status) => {
        if (live) setHooks(status);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <p className="settings-lede">
        The coding tools Anthill can hand a workflow to. Anthill looks for each one on this
        machine and asks it whether someone is signed in. It signs nobody in, handles no
        credentials and installs nothing – signing in happens in the tool&rsquo;s own window.
      </p>

      <SettingGroup
        title="Tools"
        footer="Checked again whenever you come back to Anthill, so signing in elsewhere shows up here without a restart."
      >
        {INTERPRETER_IDS.map((target, index) => {
          const harness = harnessProfile(target);
          const connection = connections.of(target);
          const badge = BADGE[connection.status];
          const setup = hooks?.harnesses.find((item) => item.id === target);
          // Pi has no hooks: Anthill follows the session file it writes, which
          // is on with nothing to set up — the Prompt flow's own words. The
          // hook status never names it, and "not available" was the opposite
          // of true (ANT-181).
          const hook =
            target === "pi"
              ? "passive – reads its session file"
              : setup && setup.cliAvailable
                ? CHIP[hookState(setup)].label
                : undefined;
          const version = connection.info?.version;

          return (
            <Fragment key={target}>
              {index > 0 ? <SettingDivider /> : null}
              <div className="tool-row">
                <img className="tool-logo" src={interpreterLogo(target)} alt="" />
                <SettingRow
                  label={harness.displayName}
                  note={
                    <>
                      {version ? <span className="mono">{version}</span> : null}
                      {version ? " · " : null}
                      Drafts workflows · Per-agent models: {harness.supportsPerAgentModel ? "yes" : "no, one per session"}
                      {" · "}Live observation: {hook ?? "not available"}
                    </>
                  }
                >
                  <StateChip tone={chipTone(connection)}>{badge.word}</StateChip>
                  <button
                    type="button"
                    className="set-btn"
                    disabled={connection.status === "checking"}
                    onClick={() => setConnecting(target)}
                  >
                    {connectLabel(connection, harness.displayName)}
                  </button>
                </SettingRow>
              </div>
            </Fragment>
          );
        })}
      </SettingGroup>

      {connecting ? (
        <ConnectHarness
          target={connecting}
          context="settings"
          connection={connections.of(connecting)}
          onRecheck={() => void connections.recheck(connecting)}
          onClose={() => setConnecting(undefined)}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

/** The tools an agent can be given a model for. Pi takes one per session. */
const PER_AGENT: InterpreterId[] = INTERPRETER_IDS.filter((target) => harnessProfile(target).supportsPerAgentModel);

/** Where a tool's list comes from, said plainly. */
function sourceOf(target: HarnessTarget, catalogues: ModelCatalogues): string {
  const harness = harnessProfile(target);
  if (harness.modelsAreDeclared) return "Declared by Anthill for this tool.";
  if (target === "codex" && catalogues.codex?.fetchedAt) {
    return `Discovered: what Codex last listed on this machine, on ${new Date(catalogues.codex.fetchedAt).toLocaleDateString()}.`;
  }
  return `Discovered: what ${harness.displayName} lists on this machine.`;
}

/** A choice as a select value, and back. */
function valueOf(choice: HarnessModelChoice | undefined): string {
  if (!choice) return "";
  return choice.reasoningEffort ? `${choice.id}::${choice.reasoningEffort}` : choice.id;
}
function choiceOf(value: string): HarnessModelChoice | undefined {
  if (!value) return undefined;
  const [id, reasoningEffort] = value.split("::");
  return reasoningEffort ? { id, reasoningEffort } : { id };
}

/**
 * One select for a model and, where the tool has them, its reasoning effort.
 *
 * Folded into one list so a tier row stays one control per tool: `gpt-5 ·
 * high` reads as the single answer it is.
 */
function ChoiceSelect({
  target,
  catalogues,
  value,
  empty,
  label,
  onChange,
}: {
  target: HarnessTarget;
  catalogues: ModelCatalogues;
  value: HarnessModelChoice | undefined;
  empty: string;
  label: string;
  onChange: (next: HarnessModelChoice | undefined) => void;
}) {
  const options = modelOptionsFor(target, catalogues);
  const current = valueOf(value);
  const known = new Set<string>([""]);
  const items: { value: string; label: string }[] = [];
  for (const option of options) {
    known.add(option.id);
    items.push({ value: option.id, label: option.label });
    for (const effort of option.efforts) {
      const key = `${option.id}::${effort.id}`;
      known.add(key);
      items.push({ value: key, label: `${option.label} · ${effort.id}` });
    }
  }
  return (
    <select aria-label={label} value={current} onChange={(event) => onChange(choiceOf(event.target.value))}>
      <option value="">{empty}</option>
      <option value={HARNESS_DEFAULT}>Default – the session&rsquo;s model</option>
      {/* A stored answer the list no longer offers stays visible rather than
          reading as though nothing were chosen. */}
      {current && current !== HARNESS_DEFAULT && !known.has(current) ? (
        <option value={current}>{current.replace("::", " · ")} – not offered now</option>
      ) : null}
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

export function ModelsPage() {
  const catalogues = useModelCatalogues();
  const { preferences, loaded, unsaved, save } = useModelPreferences();
  const connections = useHarnessConnections();

  const update = useCallback(
    (change: (current: ModelPreferences) => ModelPreferences) => void save(change(preferences)),
    [preferences, save],
  );

  const setTier = (tier: ModelTierId, target: HarnessTarget, choice: HarnessModelChoice | undefined) =>
    update((current) => {
      const mapping = { ...current.tiers[tier] };
      if (choice) mapping[target] = choice;
      else delete mapping[target];
      return { ...current, tiers: { ...current.tiers, [tier]: mapping } };
    });

  const setDefault = (target: HarnessTarget, choice: HarnessModelChoice | undefined) =>
    update((current) => {
      const defaults = { ...current.defaults };
      if (choice) defaults[target] = choice;
      else delete defaults[target];
      return { ...current, defaults };
    });

  const setShown = (target: HarnessTarget, id: string, shown: boolean) =>
    update((current) => {
      const hidden = new Set(current.hidden[target] ?? []);
      if (shown) hidden.delete(id);
      else hidden.add(id);
      const next = { ...current.hidden };
      if (hidden.size > 0) next[target] = [...hidden];
      else delete next[target];
      return { ...current, hidden: next };
    });

  /** A tool whose list can be offered: connected, and a list was given. */
  const usable = (target: InterpreterId) =>
    isConnected(connections.of(target)) && !catalogueMissing(target, catalogues);

  return (
    <>
      <p className="settings-lede">
        The models a workflow&rsquo;s agents can use, from the same lists the agent editors
        read. What you set here is a preference on this machine: it shapes what the editors
        offer, and an agent file still says exactly which model it uses for each tool.
      </p>

      {unsaved ? (
        <p className="set-result" role="alert">
          <i aria-hidden="true" />
          <span>That change was not saved; this page shows what is stored. {unsaved}</span>
        </p>
      ) : null}

      <SettingGroup
        title="Tiers"
        footer="Applying a tier to an agent writes that tier's model into each tool's slot, so the workflow file stays explicit and means the same on every machine. A tool a tier leaves unmapped keeps the agent's own answer."
      >
        {MODEL_TIERS.map((tier, index) => (
          <Fragment key={tier}>
            {index > 0 ? <SettingDivider /> : null}
            <SettingRow label={MODEL_TIER_LABELS[tier].label} note={MODEL_TIER_LABELS[tier].hint}>
              <span className="tier-maps">
                {PER_AGENT.map((target) =>
                  usable(target) ? (
                    <label className="tier-map" key={target}>
                      <span>{harnessProfile(target).displayName}</span>
                      <ChoiceSelect
                        target={target}
                        catalogues={catalogues}
                        value={preferences.tiers[tier][target]}
                        empty="Not mapped"
                        label={`${MODEL_TIER_LABELS[tier].label} on ${harnessProfile(target).displayName}`}
                        onChange={(choice) => setTier(tier, target, choice)}
                      />
                    </label>
                  ) : null,
                )}
              </span>
            </SettingRow>
          </Fragment>
        ))}
      </SettingGroup>

      {INTERPRETER_IDS.map((target) => {
        const harness = harnessProfile(target);
        const connection = connections.of(target);
        const options = modelOptionsFor(target, catalogues);
        const hidden = new Set(preferences.hidden[target] ?? []);
        const discovered = !harness.modelsAreDeclared;

        return (
          <Fragment key={target}>
            <SettingGroup
              title={harness.displayName}
              footer={
                harness.supportsPerAgentModel
                  ? sourceOf(target, catalogues)
                  : `${sourceOf(target, catalogues)} ${harness.displayName} uses one model for the whole session, so per-agent choices do not apply to it.`
              }
            >
              {!isConnected(connection) ? (
                <SettingRow
                  label="Not connected"
                  note={`Connect ${harness.displayName} on the Coding tools page to see the models it offers here.`}
                />
              ) : options.length === 0 ? (
                // Not "no models": a list nobody handed over is not one that is empty.
                <SettingRow
                  label="No list was given"
                  note={
                    target === "codex"
                      ? "Anthill has not been given Codex's model list. Open Codex once, then refresh."
                      : target === "pi"
                        ? "Anthill could not read a model list from Pi. Pi lists none until a provider is signed in – run /login in pi, then refresh."
                        : `Anthill could not read ${harness.displayName}'s model list. Refresh to ask again.`
                  }
                >
                  <button type="button" className="set-btn" onClick={catalogues.reload}>
                    Refresh
                  </button>
                </SettingRow>
              ) : (
                <>
                  {harness.supportsPerAgentModel ? (
                    <>
                      <SettingRow
                        label="New agents start with"
                        note="What a new agent is given for this tool before anyone edits it."
                      >
                        <ChoiceSelect
                          target={target}
                          catalogues={catalogues}
                          value={preferences.defaults[target]}
                          empty="Not chosen"
                          label={`Starting model on ${harness.displayName}`}
                          onChange={(choice) => setDefault(target, choice)}
                        />
                      </SettingRow>
                      <SettingDivider />
                    </>
                  ) : null}
                  {discovered ? (
                    <>
                      <SettingRow label="Model list" note={`${options.length} offered on this machine.`}>
                        <button type="button" className="set-btn" onClick={catalogues.reload}>
                          Refresh
                        </button>
                      </SettingRow>
                      <SettingDivider />
                    </>
                  ) : null}
                  {options.map((option, index) => (
                    <Fragment key={option.id}>
                      {index > 0 ? <SettingDivider /> : null}
                      <SettingRow
                        label={option.label}
                        note={
                          <>
                            <span className="mono">{option.id}</span>
                            {option.hint ? ` – ${option.hint}` : ""}
                            {option.efforts.length > 0
                              ? ` · reasoning: ${option.efforts.map((effort) => effort.id).join(", ")}`
                              : ""}
                          </>
                        }
                      >
                        {harness.supportsPerAgentModel ? (
                          <SettingSwitch
                            on={!hidden.has(option.id)}
                            label={`Offer ${option.label} in the agent editors`}
                            disabled={!loaded}
                            onChange={(shown) => setShown(target, option.id, shown)}
                          />
                        ) : null}
                      </SettingRow>
                    </Fragment>
                  ))}
                </>
              )}
            </SettingGroup>
          </Fragment>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Plugins                                                             */
/* ------------------------------------------------------------------ */

const VERDICT: Record<PluginVerdict, { label: string; tone: "on" | "quiet" | "off" }> = {
  installed: { label: "Installed", tone: "on" },
  update: { label: "Update available", tone: "quiet" },
  off: { label: "Turned off", tone: "quiet" },
  missing: { label: "Not installed", tone: "off" },
  "no-tool": { label: "Tool not found", tone: "off" },
};

function Steps({ steps }: { steps: PluginStep[] }) {
  const [copied, setCopied] = useState<string | undefined>();
  if (steps.length === 0) return null;
  return (
    <ol className="plugin-steps">
      {steps.map((step) => (
        <li key={step.says}>
          <span>{step.says}</span>
          {step.command ? (
            <span className="plugin-command">
              <code>{step.command}</code>
              <button
                type="button"
                className="set-btn"
                onClick={() => {
                  const command = step.command!;
                  void navigator.clipboard.writeText(command).then(() => setCopied(command));
                }}
              >
                {copied === step.command ? "Copied" : "Copy"}
              </button>
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function pluginNote(status: PluginHarnessStatus): string {
  const parts = [`${status.plugin}${status.marketplace ? `@${status.marketplace}` : ""}`];
  if (status.installedVersion) parts.push(`version ${status.installedVersion}`);
  if (status.availableVersion && status.availableVersion !== status.installedVersion) {
    parts.push(`${status.availableVersion} available in the checkout`);
  }
  return parts.join(" · ");
}

export function PluginsPage() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    setFailed(false);
    Promise.resolve()
      .then(() => window.anthill.pluginStatus())
      .then(setStatus)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    // Installing happens in a terminal; coming back is when the answer changes.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const checkout = status?.harnesses.find((item) => item.checkout)?.checkout;
  const server = status ? serverSteps(status.server, checkout) : [];

  return (
    <>
      <p className="settings-lede">
        Anthill&rsquo;s plugin lets Claude Code, Codex and VS Code hand a workflow to this window.
        This page reads what each tool has recorded about it. It installs nothing: the commands
        below are the tools&rsquo; own, for you to run in a terminal, and VS Code&rsquo;s steps are
        lines for its own settings.
      </p>

      {failed ? (
        <p className="set-result" role="alert">
          <i aria-hidden="true" />
          <span>Anthill could not read the plugin records. Nothing was changed.</span>
        </p>
      ) : null}

      <SettingGroup title="Plugin" footer="Read again whenever you come back to Anthill.">
        {status === null ? (
          <SettingRow label="Reading…" />
        ) : (
          status.harnesses.map((harness, index) => {
            const verdict = VERDICT[pluginVerdict(harness)];
            return (
              <Fragment key={harness.harness}>
                {index > 0 ? <SettingDivider /> : null}
                <div className="plugin-row">
                  <SettingRow label={harness.label} note={pluginNote(harness)}>
                    <StateChip tone={verdict.tone}>{verdict.label}</StateChip>
                  </SettingRow>
                  {/* A checkout either tool knows about is the one to name: the
                      same repository serves both plugins. */}
                  <Steps steps={pluginSteps({ ...harness, checkout: harness.checkout ?? checkout })} />
                </div>
              </Fragment>
            );
          })
        )}
      </SettingGroup>

      {status ? (
        <SettingGroup
          title="Server"
          footer={
            // Each plugin carries its own server and starts it, so an empty
            // settings file is the ordinary case. The file only matters when
            // it names a checkout's own build, for working on Anthill — and
            // then a name with nothing behind it stops the plugin.
            status.server.configured
              ? "Every plugin starts the server this file names instead of its own copy. A plugin that cannot find it fails the moment it is used."
              : `Each plugin carries its own copy of Anthill's local MCP server and starts it. ${status.server.settingsFile} only matters for pointing the plugins at a checkout's own build.`
          }
        >
          <div className="plugin-row">
            <SettingRow
              label="MCP server"
              note={
                <span className="mono">
                  {status.server.configured
                    ? status.server.path ?? status.server.settingsFile
                    : "the plugin's own copy"}
                </span>
              }
            >
              <StateChip tone={!status.server.configured || status.server.exists ? "on" : "quiet"}>
                {!status.server.configured
                  ? "Built into the plugin"
                  : status.server.exists
                    ? "Found"
                    : "Not found"}
              </StateChip>
            </SettingRow>
            {status.server.problem ? <p className="harness-warning">{status.server.problem}</p> : null}
            <Steps steps={server} />
          </div>
        </SettingGroup>
      ) : null}
    </>
  );
}
