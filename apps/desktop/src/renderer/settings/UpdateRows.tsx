/**
 * Updating Anthill, on Settings ▸ About (ANT-76).
 *
 * One row says where updating stands and offers the one thing to do next;
 * a second holds the switch for looking by itself. Every step forward is the
 * person's: Check, Download and Install, Restart to Update. Main does the
 * work and pushes each change, so the row only has to show what it is told.
 *
 * A shell that cannot update itself — a development run, the CLI's browser
 * page — gets the release page instead of buttons that would do nothing.
 */

import { useCallback, useEffect, useState } from "react";

import type { AppSettings, UpdateState, UpdateStatus } from "../../shared/ipc.js";
import { SettingDivider, SettingRow, SettingSwitch } from "./SettingRow.js";

/** Where updating stands, kept current by main's pushes. `undefined` until known. */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    const api = window.anthill;
    if (!api.updateStatus) return;
    let alive = true;
    let pushed = false;
    const off = api.onUpdateStatus?.((next) => {
      pushed = true;
      setStatus(next);
    });
    // A push that lands before this read answers is newer than the read.
    void api.updateStatus().then(
      (next) => {
        if (alive && !pushed) setStatus(next);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return status;
}

/** Whether the rail should point at About: there is something to act on. */
export function updateWaiting(status: UpdateStatus | undefined): boolean {
  const phase = status?.state.phase;
  return phase === "available" || phase === "downloading" || phase === "ready";
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function day(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { timeStyle: "short" });
}

/** The sentence under "Updates": what is true now, and what happens next. */
function describe(state: UpdateState, current: string) {
  switch (state.phase) {
    case "unavailable":
      return state.reason;
    case "idle":
      return "Anthill looks for new releases on GitHub.";
    case "checking":
      return "Checking GitHub for a newer release…";
    case "current": {
      const at = time(state.checkedAt);
      return `Anthill ${current} is the latest release.${at ? ` Checked at ${at}.` : ""}`;
    }
    case "available": {
      const released = day(state.releaseDate);
      return (
        <>
          Anthill {state.version} is available{released ? `, released ${released}` : ""}. Updating restarts
          Anthill; your workflows, agents and settings stay as they are, and the Anthill plugins in Claude Code
          and Codex are updated along with it.
        </>
      );
    }
    case "downloading":
      return (
        <>
          Downloading Anthill {state.version}… {state.percent}%
          {state.total > 0 ? ` (${megabytes(state.transferred)} of ${megabytes(state.total)} MB)` : ""}
          <progress
            className="set-progress"
            max={100}
            value={state.percent}
            aria-label={`Downloading Anthill ${state.version}`}
          />
        </>
      );
    case "ready":
      return `Anthill ${state.version} is downloaded and verified. Restart to finish updating, or it installs the next time you quit Anthill.`;
    case "failed":
      return <span role="alert">{state.message}</span>;
  }
}

export function UpdateRows() {
  const status = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const api = window.anthill;

  useEffect(() => {
    let live = true;
    void window.anthill.settingsRead().then(
      (value) => { if (live) setSettings(value); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);

  const setChecks = async (next: boolean) => {
    setUnsaved(false);
    try {
      setSettings(await window.anthill.settingsWrite({ updateChecks: next }));
    } catch {
      setUnsaved(true);
    }
  };

  const act = useCallback(async (run: (() => Promise<UpdateStatus>) | undefined) => {
    if (!run) return;
    setBusy(true);
    try {
      await run();
    } catch {
      // Main pushes what happened; a refused call has nothing more to say.
    } finally {
      setBusy(false);
    }
  }, []);

  const releases = (
    <button type="button" className="set-link" onClick={() => void api.openLink?.("releases")}>
      Releases on GitHub
    </button>
  );

  // A shell with no updater at all, such as the CLI's browser page.
  if (!api.updateStatus) {
    return (
      <SettingRow label="Updates" note="New versions are published on GitHub.">
        {releases}
      </SettingRow>
    );
  }
  if (!status) return <SettingRow label="Updates" note="Looking…" />;

  const { state } = status;
  let side;
  switch (state.phase) {
    case "unavailable":
      side = releases;
      break;
    case "idle":
    case "checking":
    case "current":
      side = (
        <button
          type="button"
          className="set-btn"
          disabled={busy || state.phase === "checking"}
          onClick={() => void act(api.updateCheck)}
        >
          {state.phase === "checking" ? "Checking…" : state.phase === "current" ? "Check Again" : "Check for Updates"}
        </button>
      );
      break;
    case "available":
      side = (
        <>
          <button type="button" className="set-link" onClick={() => void api.openLink?.("releases")}>
            What's new
          </button>
          <button type="button" className="set-btn primary" disabled={busy} onClick={() => void act(api.updateDownload)}>
            Download and Install
          </button>
        </>
      );
      break;
    case "downloading":
      side = (
        <button type="button" className="set-btn" onClick={() => void act(api.updateCancel)}>
          Cancel
        </button>
      );
      break;
    case "ready":
      side = (
        <button type="button" className="set-btn primary" disabled={busy} onClick={() => void act(api.updateInstall)}>
          Restart to Update
        </button>
      );
      break;
    case "failed": {
      const retry =
        state.during === "check" ? api.updateCheck : state.during === "download" ? api.updateDownload : api.updateInstall;
      side = (
        <>
          <button type="button" className="set-link" onClick={() => void api.openLink?.("releases")}>
            Download from GitHub
          </button>
          {state.retryable ? (
            <button type="button" className="set-btn" disabled={busy} onClick={() => void act(retry)}>
              Try Again
            </button>
          ) : null}
        </>
      );
      break;
    }
  }

  return (
    <>
      <SettingRow label="Updates" note={describe(state, status.current)}>
        {side}
      </SettingRow>
      {state.phase === "unavailable" ? null : (
        <>
          <SettingDivider />
          <SettingRow
            label="Check for updates automatically"
            id="update-checks"
            note="Asks GitHub for the latest release when Anthill opens and every few hours. Nothing about you or your workflows is sent, and nothing downloads until you choose to."
          >
            <SettingSwitch
              on={settings?.updateChecks ?? false}
              label="Check for updates automatically"
              disabled={!settings}
              onChange={(next) => void setChecks(next)}
            />
          </SettingRow>
          {unsaved ? <p className="set-result" role="alert">This setting was not saved.</p> : null}
        </>
      )}
    </>
  );
}
