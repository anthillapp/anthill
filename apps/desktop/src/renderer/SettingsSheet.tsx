/**
 * Settings: the things Anthill remembers about this machine.
 *
 * Reached from ⌘, at the app's own level, so it opens over whatever screen is
 * showing rather than belonging to one of them. That matters for what is in
 * it: a notification about a running session is not a property of the workflow
 * you happen to have open, and a preference you can only find while editing is
 * a preference nobody finds.
 *
 * Live observation setup moved in here too. It was already what ⌘, opened; it
 * is management — inspect, repair, disable — and this is where managing things
 * lives now.
 */

import { useCallback, useEffect, useState } from "react";

import type { AppSettings, NotificationProbe } from "../shared/ipc.js";
import { ObservationSetupCard } from "./live/ObservationSetupCard.js";

type Props = { onClose: () => void };

export function SettingsSheet({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<NotificationProbe | null>(null);

  useEffect(() => {
    let live = true;
    void window.anthill
      .settingsRead()
      .then((current) => {
        if (live) setSettings(current);
      })
      .catch(() => {
        // Unreadable preferences are the defaults, which is what the store
        // says too. The sheet still opens; it is the only way back to them.
        if (live) setSettings({ stepNotifications: false });
      });
    return () => {
      live = false;
    };
  }, []);

  const set = useCallback(async (patch: Partial<AppSettings>) => {
    setBusy(true);
    try {
      setSettings(await window.anthill.settingsWrite(patch));
    } catch {
      // Leave the switch where it was rather than showing a state that was
      // not stored.
    } finally {
      setBusy(false);
    }
  }, []);

  // Escape closes, the way every other sheet here does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const on = settings?.stepNotifications === true;

  return (
    <div className="settings-scrim" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-sheet">
        <header className="settings-top">
          <h2>Settings</h2>
          <span className="spacer" />
          <button
            type="button"
            className="icon-button"
            aria-label="Close settings"
            title="Close settings"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section" aria-label="Notifications">
            <h3>Notifications</h3>

            <label className="settings-switch">
              <input
                type="checkbox"
                checked={on}
                disabled={settings === null || busy}
                onChange={(event) => void set({ stepNotifications: event.target.checked })}
              />
              <span>
                <strong>Tell me when an observed session reaches a new step</strong>
                {/* What it takes to fire one, in the same terms the rest of the
                    app uses about evidence — so nobody expects a notification
                    from a session Anthill has not actually matched. */}
                <span className="settings-note">
                  One notification when a session Anthill is confidently watching announces a
                  step of your workflow. Not for every event it reads, not for a session it is
                  unsure of, and not for the same step twice.
                </span>
              </span>
            </label>

            <p className="settings-note">
              Anthill hands these to macOS, which decides whether they appear. It is not told
              when you allow or refuse them, so if nothing arrives, check{" "}
              <strong>System Settings ▸ Notifications ▸ Anthill</strong>. Sending one is the
              only way to find out for certain.
            </p>

            <div className="settings-actions">
              <button
                type="button"
                onClick={() => {
                  setProbe(null);
                  void window.anthill
                    .notificationsProbe()
                    .then(setProbe)
                    .catch(() =>
                      setProbe({ kind: "unsupported", reason: "The test could not be sent." }),
                    );
                }}
              >
                Send a test notification
              </button>
              {probe?.kind === "sent" ? (
                <span className="settings-note">
                  Sent. If it did not appear, macOS is holding it back.
                </span>
              ) : null}
              {probe?.kind === "unsupported" ? (
                <span className="settings-note is-warn">{probe.reason}</span>
              ) : null}
            </div>

            <p className="settings-note quiet">
              Anthill still only reads what your session writes on this machine. Nothing here
              starts, stops, answers, or steers it.
            </p>
          </section>

          <section className="settings-section" aria-label="Live observation">
            <h3>Live observation</h3>
            <ObservationSetupCard firstMeaningfulEdit={false} forceOpen onClose={onClose} />
          </section>
        </div>
      </div>
    </div>
  );
}
