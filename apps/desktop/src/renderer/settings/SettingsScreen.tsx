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

import { PLATFORM_SCOPE, type ExternalLink } from "../../shared/links.js";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CodexHookHelp } from "../live/CodexHookHelp.js";
import { useSetupPoll } from "../live/use-setup-poll.js";
import { CHIP, hookState } from "./hook-state.js";
import { UnsupportedWindowsChip } from "../windows/unsupported-windows.js";
import { CodingToolsPage, ModelsPage, PluginsPage } from "./ToolPages.js";

import { DEFAULT_WORKFLOW_FOLDER } from "../../shared/ipc.js";
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

/** The pages, in the three groups the rail shows them in. */
const NAV = [
  {
    label: "Anthill",
    items: [
      { id: "general", label: "General" },
      { id: "notifications", label: "Notifications" },
      { id: "privacy", label: "Privacy" },
    ],
  },
  {
    label: "Tools",
    items: [
      { id: "tools", label: "Coding tools" },
      { id: "models", label: "Models" },
      { id: "plugins", label: "Plugins" },
    ],
  },
  {
    label: "Sessions",
    items: [
      { id: "observation", label: "Live observation" },
      { id: "about", label: "About" },
    ],
  },
] as const;

export type PageId = (typeof NAV)[number]["items"][number]["id"];

const TITLES: Record<PageId, string> = {
  general: "General",
  notifications: "Notifications",
  privacy: "Privacy",
  tools: "Coding tools",
  models: "Models",
  plugins: "Plugins",
  observation: "Live observation",
  about: "About",
};

export function SettingsScreen({
  onLeave,
  initialPage = "general",
}: {
  onLeave: () => void;
  /** Where to open, when Settings was asked for about one thing in particular. */
  initialPage?: PageId;
}) {
  const [page, setPage] = useState<PageId>(initialPage);
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

          {/* With the footer rather than the pages: a quiet link out, not a
              setting and not a call to action. */}
          <div className="win-chip-rail">
            <UnsupportedWindowsChip skin="on-dark" />
          </div>
          <button
            type="button"
            className="settings-coffee on-dark"
            onClick={() => void window.anthill.openLink?.("support")}
          >
            {/* Lucide's `coffee`: a cup, not anybody's logo. */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 2v2" />
              <path d="M14 2v2" />
              <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
              <path d="M6 2v2" />
            </svg>
            <span>Buy me a coffee</span>
          </button>

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
            {page === "general" ? <GeneralPage /> : null}
            {page === "notifications" ? <NotificationsPage /> : null}
            {page === "privacy" ? <PrivacyPage /> : null}
            {page === "tools" ? <CodingToolsPage /> : null}
            {page === "models" ? <ModelsPage /> : null}
            {page === "plugins" ? <PluginsPage /> : null}
            {page === "observation" ? <ObservationPage /> : null}
            {page === "about" ? <AboutPage /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const ALL_OFF: AppSettings = {
  analyticsEnabled: false,
  errorReportingEnabled: false,
  nativeCrashReportingEnabled: false,
  stepNotifications: false,
  stepFinishedNotifications: false,
  loopNotifications: false,
  needsYouNotifications: false,
  finishedNotifications: false,
  observationLostNotifications: false,
  workflowFolder: "",
};

/**
 * General: where new workflows are saved.
 *
 * The folder is where the save dialog opens for a workflow that has never
 * been saved. It is not a place Anthill moves files to, so the note says
 * exactly that: changing it moves nothing, a saved workflow keeps saving where
 * it is, and the old files stay under Recent. The CLI saves into the workspace
 * it was started with, so there the row says so instead of offering a change
 * it would ignore.
 */
export function GeneralPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [cli, setCli] = useState(false);
  const [unsaved, setUnsaved] = useState(false);

  useEffect(() => {
    let live = true;
    void window.anthill.settingsRead().then(
      (value) => { if (live) setSettings(value); },
      () => { if (live) setSettings({ ...ALL_OFF }); },
    );
    void window.anthill.capabilities?.().then(
      (capabilities) => { if (live) setCli(capabilities.shell === "cli"); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);

  const change = async () => {
    setUnsaved(false);
    try {
      const next = await window.anthill.chooseWorkflowFolder();
      if (next) setSettings(next);
    } catch {
      setUnsaved(true);
    }
  };

  const folder = settings?.workflowFolder || DEFAULT_WORKFLOW_FOLDER;

  return (
    <SettingGroup
      title="Workflows"
      footer={
        cli
          ? "The Anthill CLI saves new workflows into the workspace it was started with."
          : "Changing the folder moves nothing that is already saved. A new workflow opens its first save here; one saved before keeps saving where it is, and still shows under Recent."
      }
    >
      <SettingRow
        label="Workflow folder"
        note="Where your saved workflows are kept. Each one is an ordinary JSON file you can commit next to the code it is about."
      >
        {cli ? null : (
          <>
            <span className="set-path mono" title={folder}>
              {folder}
            </span>
            <button type="button" className="set-btn" disabled={settings === null} onClick={() => void change()}>
              Change…
            </button>
          </>
        )}
      </SettingRow>
      {unsaved ? <p className="set-result" role="alert">This folder was not saved.</p> : null}
    </SettingGroup>
  );
}

/** Exported with `available` so tests can render the release build's page. */
export function PrivacyPage({ available = __ANTHILL_DIAGNOSTICS__ }: { available?: boolean }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // The CLI serves this page to a browser: there is no Electron to dump.
  const [cli, setCli] = useState(false);

  useEffect(() => {
    let live = true;
    void window.anthill.settingsRead().then(
      (value) => { if (live) setSettings(value); },
      () => { if (live) setSettings({ ...ALL_OFF }); },
    );
    void window.anthill.capabilities?.().then(
      (capabilities) => { if (live) setCli(capabilities.shell === "cli"); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);

  const set = async (key: keyof Pick<AppSettings, "analyticsEnabled" | "errorReportingEnabled" | "nativeCrashReportingEnabled">, value: boolean) => {
    setBusy(true);
    setUnsaved(false);
    try {
      setSettings(await window.anthill.settingsWrite({ [key]: value }));
    } catch {
      setUnsaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingGroup
      title="Optional diagnostics"
      footer={!available
        ? "This build never sends diagnostics. Only the released macOS app and the Anthill CLI can, and only after you turn them on."
        : cli
          ? "All sharing is off until you turn it on. Reports leave from the Anthill CLI process, never from this page."
          : "All sharing is off until you turn it on. Development builds do not send diagnostics."}
    >
      <SettingRow
        label="Anonymous product analytics"
        note="Sends a random app identifier and the names of these actions: opening Anthill, enabling analytics, opening or saving a workflow, and starting live observation. PostHog also receives the SDK name and version, and discards your IP address. No workflow content, prompts, paths, clicks, pageviews, or recordings. Turning this off removes the local identifier."
      >
        <SettingSwitch
          on={settings?.analyticsEnabled === true}
          label="Anonymous product analytics"
          disabled={!available || settings === null || busy}
          onChange={(next) => void set("analyticsEnabled", next)}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow
        label="JavaScript error reports"
        note="Sends error stack locations with messages and runtime data removed. Starts after you restart Anthill. Turning it off stops new reports immediately."
      >
        <SettingSwitch
          on={settings?.errorReportingEnabled === true}
          label="JavaScript error reports"
          disabled={!available || settings === null || busy}
          onChange={(next) => void set("errorReportingEnabled", next)}
        />
      </SettingRow>
      {cli ? null : (
        <>
          <SettingDivider />
          <SettingRow
            label="Native crash reports"
            note="Separately allows Electron memory dumps to be sent after a crash. A dump may contain private text or credentials from memory. Requires JavaScript error reports and a restart."
          >
            <SettingSwitch
              on={settings?.nativeCrashReportingEnabled === true}
              label="Native crash reports"
              disabled={!available || settings === null || busy || !settings.errorReportingEnabled}
              onChange={(next) => void set("nativeCrashReportingEnabled", next)}
            />
          </SettingRow>
        </>
      )}
      {unsaved ? <p className="set-result" role="alert">This preference was not saved.</p> : null}
    </SettingGroup>
  );
}

/**
 * One switch per moment worth interrupting for, each asked for on its own.
 *
 * The order is the order of a session: a step starts, it finishes, the work
 * may come back round, it may stop to ask, and in the end it finishes or is
 * lost. The wording says what Anthill can honestly claim for each — a step is
 * "finished" because the session moved on, not because anything was checked.
 */
const NOTICE_ROWS: { key: keyof AppSettings; label: string; note: string }[] = [
  {
    key: "stepNotifications",
    label: "A step starts",
    note: "The session announced it is starting a step. Never twice for the same step.",
  },
  {
    key: "stepFinishedNotifications",
    label: "A step finishes",
    note: "The session moved on to the next step, or said the work is done – which is as finished as Anthill can say.",
  },
  {
    key: "loopNotifications",
    label: "A loop comes back round",
    note: "The session announced a step it had already been through – a rework loop, or a return of its own.",
  },
  {
    key: "needsYouNotifications",
    label: "The session is waiting on you",
    note: "The CLI recorded that it needs a person: a permission prompt, a question. Needs the local hooks to be installed.",
  },
  {
    key: "finishedNotifications",
    label: "The session finishes or fails",
    note: "The record says the work is done, or that it stopped on an error.",
  },
  {
    key: "observationLostNotifications",
    label: "Anthill loses the session",
    note: "It stopped writing anything Anthill can read for long enough that Anthill no longer claims to be watching it.",
  },
];

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
        if (live) setSettings({ ...ALL_OFF });
      });
    return () => {
      live = false;
    };
  }, []);

  const set = useCallback(async (key: keyof AppSettings, next: boolean) => {
    setBusy(true);
    setUnsaved(null);
    try {
      setSettings(await window.anthill.settingsWrite({ [key]: next }));
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

  /** Whether anything at all would be sent — what makes the permission row worth showing. */
  const anyOn = settings !== null && NOTICE_ROWS.some((row) => settings[row.key]);

  return (
    <>
      <SettingGroup
        title="What to tell me about"
        footer="Each is one notification the first time it happens, only for a session Anthill is confident is yours. Anthill still only reads what your session writes on this machine. Nothing here starts, stops, answers or steers it."
      >
        {NOTICE_ROWS.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? <SettingDivider /> : null}
            <SettingRow label={row.label} note={row.note}>
              <SettingSwitch
                on={settings?.[row.key] === true}
                label={row.label}
                disabled={settings === null || busy}
                onChange={(next) => void set(row.key, next)}
              />
            </SettingRow>
          </Fragment>
        ))}

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

        {/* Only while something is on: permission is meaningless when nothing
            would be sent, and a row about it would be a question nobody asked.
            And only in a development build: the test button is a diagnostic
            for whoever is working on Anthill, not a control for whoever is
            using it. */}
        {anyOn && import.meta.env.DEV ? (
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

  const refresh = useCallback(async (light = false) => {
    setStatus(await window.anthill.liveSetupStatus(undefined, light));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingTrust = status?.harnesses.some((h) => h.id === "codex" && h.hookInstalled && h.codexHooks?.state !== "ready") ?? false;
  useSetupPoll(() => refresh(true), busy === null, pendingTrust);

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
        from a copied prompt. This is optional – designing workflows and copying
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
        footer={
          <>
            Anthill reads event metadata only – no transcript, no file
            contents, and none of the model&rsquo;s reasoning. A hook writes
            down which tool ran, when, and what it was aimed at; the command
            itself, the contents it wrote and the answer it got are not kept,
            and anything that looks like a credential is replaced before the
            line is written. The log lives in{" "}
            <strong>~/.anthill/live-hooks</strong>, rolls over at 8&nbsp;MB and
            keeps one previous file. Nothing here is ever sent anywhere.
          </>
        }
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

      {harness.codexHooks ? <CodexHookHelp status={harness.codexHooks} /> : null}
      {state === "silent" ? (
        <p className="harness-warning">
          No hook events are in the retained log yet. Start a session to verify
          detailed progress. Basic progress from local session records remains available.
        </p>
      ) : null}
      {state === "broken" || (harness.hookEntriesPresent && harness.hookUsesCurrentRuntime === false) ? (
        <button type="button" className="set-btn" disabled={busy} onClick={onInstall}>
          {busy ? "Repairing…" : "Repair connection"}
        </button>
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
                "–"
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

/** A listed page, opened by name in the default browser. */
function AboutLink({ name, children }: { name: ExternalLink; children: string }) {
  return (
    <button type="button" className="set-link" onClick={() => void window.anthill.openLink?.(name)}>
      {children}
    </button>
  );
}

function AboutPage() {
  return (
    <SettingGroup title="Anthill">
      <SettingRow
        label="Version"
        note="Local-first. Nothing is sent anywhere unless you turn it on under Privacy."
      >
        <span className="set-note">{__ANTHILL_VERSION__}</span>
      </SettingRow>
      <SettingDivider />
      {/* On every platform: this is the product's public statement of scope,
          in the same words as the README, the CLI and the release notes. */}
      <SettingRow label="Platforms" note={PLATFORM_SCOPE}>
        <AboutLink name="windowsIssue">Report a Windows issue</AboutLink>
      </SettingRow>
      <SettingDivider />
      <SettingRow
        label="Source"
        note="Anthill designs workflows and watches the session you start yourself. It never runs one."
      >
        <AboutLink name="source">github.com/nstr/anthill</AboutLink>
      </SettingRow>
      <SettingDivider />
      <SettingRow label="Community" note="Questions, ideas and workflows from other people using Anthill.">
        <AboutLink name="community">r/AnthillApp</AboutLink>
      </SettingRow>
      <SettingDivider />
      <SettingRow label="Website" note="News, releases and how to get in touch.">
        <AboutLink name="website">getanthill.ai</AboutLink>
      </SettingRow>
      <SettingDivider />
      <SettingRow label="Support Anthill" note="If Anthill saves you time, a coffee helps keep it going.">
        <AboutLink name="support">Buy me a coffee</AboutLink>
      </SettingRow>
    </SettingGroup>
  );
}
