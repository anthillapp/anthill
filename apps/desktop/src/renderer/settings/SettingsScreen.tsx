/**
 * Settings, as a screen.
 *
 * It was a modal with a card nested inside it, and the review of that found
 * five problems that were all the same problem: nothing owned the page. The
 * nested card brought its own heading and outranked the word *Settings*; it
 * brought its own two ways to close, one of which quietly did something
 * permanent under a neutral word; and a setting you change looked identical to
 * a status you read.
 *
 * So there is one owner now, and it is this file. The rail names the page, the
 * header repeats it as the only `<h1>`, groups carry small uppercase titles,
 * and nothing nested brings a heading of its own.
 *
 * **One way out.** The back arrow, which returns to the screen Settings was
 * opened from rather than dumping you on the launch window — you came here
 * from somewhere, and you were in the middle of something there.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AppSettings,
  MarkerCli,
  NotificationProbe,
  ObservationHarnessSetup,
  ObservationSetupStatus,
} from "../../shared/ipc.js";
import {
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingSwitch,
  StateChip,
} from "./SettingRow.js";

/** The pages, in the two groups the rail shows them in. */
const NAV = [
  {
    label: "Anthill",
    items: [{ id: "notifications", label: "Notifications" }],
  },
  {
    label: "Sessions",
    items: [
      { id: "observation", label: "Live observation" },
      { id: "about", label: "About" },
    ],
  },
] as const;

type PageId = (typeof NAV)[number]["items"][number]["id"];

const TITLES: Record<PageId, string> = {
  notifications: "Notifications",
  observation: "Live observation",
  about: "About",
};

/**
 * What the card can honestly claim about a harness's hooks.
 *
 * Four states, and each is a different claim. Entries in a config file are not
 * hooks that run (ANT-23), and hooks that run are not hooks the harness calls
 * (ANT-42) — Codex had six entries, a handler that ran on demand and, across
 * eight sessions, not one event, while the card said Enabled.
 */
type HookState = "enabled" | "silent" | "broken" | "available";

function hookState(harness: ObservationHarnessSetup): HookState {
  if (!harness.hookEntriesPresent) return "available";
  if (!harness.hookInstalled) return "broken";
  return harness.hookLastEventAt ? "enabled" : "silent";
}

const CHIP: Record<HookState, { label: string; tone: "on" | "quiet" | "off" }> =
  {
    enabled: { label: "Enabled", tone: "on" },
    silent: { label: "Not seen firing", tone: "quiet" },
    broken: { label: "Not working", tone: "quiet" },
    available: { label: "Available", tone: "off" },
  };

/** How long ago, in the roundest words that are still true. */
function since(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "time";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "time";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

export function SettingsScreen({ onLeave }: { onLeave: () => void }) {
  const [page, setPage] = useState<PageId>("notifications");
  const [query, setQuery] = useState("");

  const nav = useMemo(() => {
    const want = query.trim().toLowerCase();
    return NAV.map((group) => ({
      label: group.label,
      items: group.items.filter(
        (item) => !want || item.label.toLowerCase().includes(want),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    // The app's own shell, so the page fills the window under the title bar the
    // way every other screen does.
    <div className="app">
      <div className="settings-page">
        <nav className="settings-rail" aria-label="Settings">
          <div className="settings-rail-top">
            {/* The one way out. No ✕, no Close, no Not now. */}
            <button
              type="button"
              className="settings-back on-dark"
              aria-label="Back to Anthill"
              title="Back to Anthill"
              onClick={onLeave}
            >
              ←
            </button>
            <h2>Settings</h2>
          </div>

          <div className="settings-search">
            <span aria-hidden="true">⌕</span>
            <input
              className="on-dark"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search settings"
              placeholder="Search settings"
            />
          </div>

          <div className="settings-nav">
            {nav.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <span>{group.label}</span>
                {group.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="on-dark"
                    aria-current={page === item.id ? "page" : undefined}
                    onClick={() => setPage(item.id)}
                  >
                    <i className="mark" aria-hidden="true" />
                    <span className="label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <p className="settings-rail-foot">
            Anthill reads what your session writes on this machine. It does not
            start, stop or answer one.
          </p>
        </nav>

        <div className="settings-main">
          <header className="settings-header">
            <h1>{TITLES[page]}</h1>
          </header>
          <div className="settings-body">
            {page === "notifications" ? <NotificationsPage /> : null}
            {page === "observation" ? <ObservationPage /> : null}
            {page === "about" ? <AboutPage /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function NotificationsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<NotificationProbe | null>(null);
  /** A preference the disk refused. Cleared by the next attempt. */
  const [unsaved, setUnsaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.anthill
      .settingsRead()
      .then((current) => {
        if (live) setSettings(current);
      })
      // Unreadable preferences are the defaults, which is what the store says
      // too. The page still opens; it is the only way back to them.
      .catch(() => {
        if (live) setSettings({ stepNotifications: false });
      });
    return () => {
      live = false;
    };
  }, []);

  const set = useCallback(async (next: boolean) => {
    setBusy(true);
    setUnsaved(null);
    try {
      setSettings(
        await window.anthill.settingsWrite({ stepNotifications: next }),
      );
      // The permission row is about to appear or disappear with the switch; a
      // result from before that is about a question nobody is asking now.
      setProbe(null);
    } catch (error) {
      // The switch stays where it was, because that is what is stored — and
      // saying so is the point. Leaving it silent meant a preference the disk
      // had refused looked accepted until the next launch (ANT-97).
      setUnsaved(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const on = settings?.stepNotifications === true;

  return (
    <>
      <SettingGroup
        title="Step transitions"
        footer="Anthill still only reads what your session writes on this machine. Nothing here starts, stops, answers or steers it."
      >
        <SettingRow
          label="Tell me when an observed session reaches a new step"
          note="One notification the first time a step starts. Not for every event Anthill reads, never twice for the same step, and only for a session it is confident is yours."
        >
          <SettingSwitch
            on={on}
            label="Tell me when an observed session reaches a new step"
            disabled={settings === null || busy}
            onChange={(next) => void set(next)}
          />
        </SettingRow>

        {/* Outside the `on` block below, deliberately: a write the disk
            refuses leaves the switch off, which is precisely when that block
            is not rendered. */}
        {unsaved ? (
          <p className="set-result" role="alert">
            <i aria-hidden="true" />
            <span>
              This preference was not saved. The switch shows what is stored,
              which is what it was before. {unsaved}
            </span>
          </p>
        ) : null}

        {/* Only while the switch is on: permission is meaningless when nothing
            would be sent, and a row about it would be a question nobody asked. */}
        {on ? (
          <>
            <SettingDivider />
            <SettingRow
              label="macOS permission"
              note={
                <>
                  Anthill hands these to macOS, which decides whether they
                  appear. It is not told when you allow or refuse them, so if
                  nothing arrives, check{" "}
                  <strong>System Settings ▸ Notifications ▸ Anthill</strong>.
                </>
              }
            >
              <StateChip tone="quiet">Not known</StateChip>
              <button
                type="button"
                className="set-btn"
                onClick={() => {
                  setProbe(null);
                  void window.anthill
                    .notificationsProbe()
                    .then(setProbe)
                    .catch(() =>
                      setProbe({
                        kind: "unsupported",
                        reason: "The test could not be sent.",
                      }),
                    );
                }}
              >
                Send a test
              </button>
            </SettingRow>
            {probe ? (
              <p className="set-result" role="status">
                <i aria-hidden="true" />
                <span>
                  {probe.kind === "sent"
                    ? "Sent. If nothing appeared, macOS is holding it back rather than Anthill."
                    : probe.reason}
                </span>
              </p>
            ) : null}
          </>
        ) : null}
      </SettingGroup>
    </>
  );
}

function ObservationPage() {
  const [status, setStatus] = useState<ObservationSetupStatus | null>(null);
  const [open, setOpen] = useState<MarkerCli | null>(null);
  const [busy, setBusy] = useState<MarkerCli | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.anthill.liveSetupStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (id: MarkerCli, what: "install" | "disable") => {
      setBusy(id);
      const result =
        what === "install"
          ? await window.anthill.liveSetupInstall(id)
          : await window.anthill.liveSetupDisable(id);
      setBusy(null);
      setStatus(result.status);
      setMessage(result.ok ? result.message : result.error);
    },
    [],
  );

  const available =
    status?.harnesses.filter((harness) => harness.cliAvailable) ?? [];

  return (
    <>
      {/* The lede, which used to be the nested card's own heading and two
          paragraphs. The page owns it now. */}
      <p className="settings-lede">
        Anthill can watch the Codex or Claude Code session you start yourself
        from a copied prompt. This is optional — designing workflows and copying
        prompts work without it. Hooks add permission and notification events
        and real tool durations on top of the session records Anthill already
        reads.
      </p>

      {message ? (
        <p className="set-result" role="status">
          <i aria-hidden="true" />
          <span>{message}</span>
        </p>
      ) : null}

      <SettingGroup
        title="Hooks"
        footer="Anthill reads event metadata only — no transcript, no file contents, and none of the model's reasoning."
      >
        {available.length === 0 ? (
          <SettingRow
            label="No supported CLI was found on this machine"
            note="You can keep designing workflows and copying prompts, and come back here once one is installed."
          />
        ) : (
          available.map((harness) => (
            <Harness
              key={harness.id}
              harness={harness}
              expanded={open === harness.id}
              busy={busy === harness.id}
              onToggle={() =>
                setOpen((current) =>
                  current === harness.id ? null : harness.id,
                )
              }
              onInstall={() => void act(harness.id, "install")}
              onDisable={() => void act(harness.id, "disable")}
            />
          ))
        )}
      </SettingGroup>
    </>
  );
}

/**
 * One harness: a state you read, and one action.
 *
 * The old card offered `Review setup` and `Disable Anthill hooks` side by side,
 * twice, told apart only by a small uppercase name. Disable now lives inside
 * the detail this button opens, named in full and with its consequence beside
 * it — a destructive action should cost a deliberate step and never sit as a
 * peer of a read action.
 */
function Harness({
  harness,
  expanded,
  busy,
  onToggle,
  onInstall,
  onDisable,
}: {
  harness: ObservationHarnessSetup;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onInstall: () => void;
  onDisable: () => void;
}) {
  const state = hookState(harness);
  const chip = CHIP[state];

  return (
    <div className="harness-row">
      <SettingRow
        label={harness.label}
        note={
          harness.version
            ? `${harness.cliCommand} ${harness.version}`
            : harness.cliCommand
        }
      >
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
        <button
          type="button"
          className="set-btn"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "Hide setup" : "Review setup"}
        </button>
      </SettingRow>

      {harness.hookProblem ? (
        <p className="harness-warning">
          Anthill installed hooks here, but they are not running.{" "}
          {harness.hookProblem} Until this is fixed, Anthill reads this
          harness&rsquo;s session records only, which is the baseline and still
          works.
        </p>
      ) : null}

      {/* Amber, not red: hooks that never fired may simply be how this build
          works, and the session-record baseline is unaffected either way. */}
      {state === "silent" ? (
        <p className="harness-warning">
          The hooks are installed and the handler runs when Anthill calls it,
          but {harness.label} has never called it — no event has arrived
          {harness.hookInstalledAt
            ? ` in the ${since(harness.hookInstalledAt)} since they were installed`
            : ""}
          . That may simply be how this build works. Anthill reads this
          harness&rsquo;s session records either way; what is missing is
          permission and notification events and real tool durations.
        </p>
      ) : null}

      {expanded ? (
        <div className="harness-details">
          <dl>
            <dt>Installer action</dt>
            <dd>{harness.installerAction}</dd>
            <dt>Config file</dt>
            <dd className="mono">{harness.configPath}</dd>
            <dt>Handler</dt>
            <dd className="mono">{harness.hookHandlerPath}</dd>
            <dt>Entries</dt>
            {/* One per line. Joined into a paragraph these are a wall that
                takes over the panel, and the thing worth reading — how many
                there are, and that they all point at Anthill's own handler —
                is exactly what a wall hides. */}
            <dd className="mono">
              {harness.hookCommands.length === 0 ? (
                "—"
              ) : (
                <ul className="harness-entries">
                  {harness.hookCommands.map((command) => (
                    <li key={command}>{command}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Events</dt>
            <dd>{harness.eventCategories.join(", ")}</dd>
            <dt>Data boundary</dt>
            <dd>{harness.localDataBoundary}</dd>
            <dt>What changes</dt>
            <dd>{harness.changes.join(" ")}</dd>
          </dl>

          <div className="harness-details-actions">
            {harness.hookEntriesPresent ? (
              <>
                <button
                  type="button"
                  className="set-btn-danger"
                  disabled={busy}
                  onClick={onDisable}
                >
                  {busy ? "Disabling…" : `Disable hooks for ${harness.label}`}
                </button>
                <span className="set-note">
                  Observation falls back to session records.
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy}
                  onClick={onInstall}
                >
                  {busy ? "Enabling…" : `Enable for ${harness.label}`}
                </button>
                <span className="set-note">
                  Anthill merges its entries into this file and keeps a backup,
                  leaving unrelated hooks alone.
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AboutPage() {
  return (
    <SettingGroup title="Anthill">
      <SettingRow
        label="Version"
        note="Local-first. Nothing here is sent anywhere."
      >
        <span className="set-note">{__ANTHILL_VERSION__}</span>
      </SettingRow>
      <SettingDivider />
      <SettingRow
        label="Source"
        note="Anthill designs workflows and watches the session you start yourself. It never runs one."
      >
        <span className="set-note mono">github.com/nstr/anthill</span>
      </SettingRow>
    </SettingGroup>
  );
}
