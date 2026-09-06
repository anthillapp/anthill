import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  MarkerCli,
  ObservationHarnessSetup,
  ObservationSetupStatus,
} from "../../shared/ipc.js";

type Props = {
  firstMeaningfulEdit: boolean;
  forceOpen: boolean;
  onClose: () => void;
};

const NO_RUNNER_WORDS = "No Start, Run, Attach, Listen, Watch, permission, or workflow execution controls are added.";

/** What the card can honestly claim about a harness's hooks. */
type HookState = "enabled" | "silent" | "broken" | "available";

function state(harness: ObservationHarnessSetup): HookState {
  if (!harness.hookEntriesPresent) return "available";
  if (!harness.hookInstalled) return "broken";
  return harness.hookLastEventAt ? "enabled" : "silent";
}

const CHIP_LABEL: Record<HookState, string> = {
  enabled: "Enabled",
  silent: "Not seen firing",
  broken: "Not working",
  available: "Available",
};

/** How long ago, in the roundest words that are still true. */
function since(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "time";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "time";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

const CHIP_TONE: Record<HookState, string> = {
  enabled: "ok",
  silent: "warn",
  broken: "warn",
  available: "neutral",
};

export function ObservationSetupCard({ firstMeaningfulEdit, forceOpen, onClose }: Props) {
  const [status, setStatus] = useState<ObservationSetupStatus | null>(null);
  const [reviewing, setReviewing] = useState<MarkerCli | null>(null);
  const [busy, setBusy] = useState<MarkerCli | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.anthill.liveSetupStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const available = useMemo(
    () => status?.harnesses.filter((harness) => harness.cliAvailable) ?? [],
    [status],
  );
  const shouldShow = Boolean(
    status &&
      (forceOpen ||
        message !== null ||
        (firstMeaningfulEdit &&
          !status.dismissed &&
          available.some((harness) => !harness.hookInstalled))),
  );

  const dismiss = useCallback(async () => {
    setStatus(await window.anthill.liveSetupDismiss());
    setReviewing(null);
    setMessage(null);
    onClose();
  }, [onClose]);

  const install = useCallback(async (id: MarkerCli) => {
    setBusy(id);
    const result = await window.anthill.liveSetupInstall(id);
    setBusy(null);
    setStatus(result.status);
    setMessage(result.ok ? result.message : result.error);
  }, []);

  const disable = useCallback(async (id: MarkerCli) => {
    setBusy(id);
    const result = await window.anthill.liveSetupDisable(id);
    setBusy(null);
    setStatus(result.status);
    setMessage(result.ok ? result.message : result.error);
  }, []);

  if (!shouldShow || !status) return null;

  return (
    <section className="observation-setup" aria-label="Live observation setup">
      <div className="setup-copy">
        <p className="kicker">Live observation setup</p>
        <h2>Enable local hooks for honest Live Session progress</h2>
        <p>
          Anthill can observe the Codex or Claude Code session you start yourself from a
          copied prompt. Setup is optional; designing workflows and exporting prompts still work without it.
        </p>
        <p className="quiet">
          Trigger: {status.trigger} {NO_RUNNER_WORDS} MCP is optional and not required.
        </p>
      </div>

      {message ? <div className="setup-message">{message}</div> : null}

      {available.length === 0 ? (
        <div className="setup-empty">
          No supported local CLI was found on PATH. You can keep designing and return here later.
        </div>
      ) : (
        <div className="setup-harnesses">
          {available.map((harness) => (
            <HarnessReview
              key={harness.id}
              harness={harness}
              expanded={reviewing === harness.id}
              busy={busy === harness.id}
              onReview={() => setReviewing((current) => (current === harness.id ? null : harness.id))}
              onInstall={() => void install(harness.id)}
              onDisable={() => void disable(harness.id)}
            />
          ))}
        </div>
      )}

      <div className="setup-actions">
        <button onClick={dismiss}>Not now</button>
        {forceOpen ? <button onClick={onClose}>Close</button> : null}
      </div>
    </section>
  );
}

function HarnessReview({
  harness,
  expanded,
  busy,
  onReview,
  onInstall,
  onDisable,
}: {
  harness: ObservationHarnessSetup;
  expanded: boolean;
  busy: boolean;
  onReview: () => void;
  onInstall: () => void;
  onDisable: () => void;
}) {
  return (
    <article className="setup-harness">
      <div className="setup-harness-head">
        <div>
          <h3>{harness.label}</h3>
          <p>
            {harness.version ? `${harness.cliCommand} ${harness.version}` : harness.cliCommand}
          </p>
        </div>
        {/* Four states, and each is a different claim. Entries in a config
            file are not hooks that run (ANT-23), and hooks that run are not
            hooks the harness calls (ANT-42) — Codex had six entries, a
            handler that ran on demand and, across eight sessions, not one
            event, while the card said Enabled. */}
        <span className={`chip ${CHIP_TONE[state(harness)]}`}>{CHIP_LABEL[state(harness)]}</span>
      </div>

      {harness.hookProblem ? (
        <p className="setup-problem">
          Anthill installed hooks here, but they are not running. {harness.hookProblem} Until
          this is fixed, Anthill reads this harness&rsquo;s session records only, which is the
          baseline and still works.
        </p>
      ) : null}

      {state(harness) === "silent" ? (
        // Not an error, and worded so it cannot be read as one: it may be
        // permanently true of a harness with no hook mechanism, which is what
        // the research suggests of the Codex behind these session records.
        <p className="setup-quiet-problem">
          The hooks are installed and the handler runs when Anthill calls it, but{" "}
          {harness.label} has never called it — no event has arrived
          {harness.hookInstalledAt ? ` in the ${since(harness.hookInstalledAt)} since they were installed` : ""}.
          That may simply be how this build works. Anthill reads this
          harness&rsquo;s session records either way, which is the baseline and is unaffected;
          what is missing is permission and notification events and real tool durations.
        </p>
      ) : null}

      <div className="setup-harness-actions">
        <button onClick={onReview}>{expanded ? "Hide review" : "Review setup"}</button>
        {harness.hookEntriesPresent ? (
          <button onClick={onDisable} disabled={busy}>
            {busy ? "Disabling..." : "Disable Anthill hooks"}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="setup-review">
          <Field label="Installer action" value={harness.installerAction} />
          <List label="Hook commands installed in config" items={harness.hookCommands} mono />
          <Field label="Target config file" value={harness.configPath} mono />
          <Field label="Hook handler path" value={harness.hookHandlerPath} mono />
          <Field label="Local data boundary" value={harness.localDataBoundary} />
          <List label="Observed event categories" items={harness.eventCategories} />
          <List label="What will change" items={harness.changes} />
          <p className="quiet">
            Anthill backs up and merges this configuration, preserving unrelated hooks.
            Disable removes only Anthill observation entries.
          </p>
          {!harness.hookInstalled ? (
            <button className="primary" onClick={onInstall} disabled={busy}>
              {busy
                ? `Enabling ${harness.label}...`
                : harness.hookEntriesPresent
                  ? `Repair ${harness.label} hooks`
                  : `Enable for ${harness.label}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="setup-field">
      <span>{label}</span>
      <code className={mono ? undefined : "plain"}>{value}</code>
    </div>
  );
}

function List({ label, items, mono = false }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div className="setup-field">
      <span>{label}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{mono ? <code>{item}</code> : item}</li>
        ))}
      </ul>
    </div>
  );
}
