/**
 * What a screen shows when the process behind it is older than the screen.
 *
 * The point of this component is that it exists at all. The failure it reports
 * used to look like success with nothing in it — an empty feed reads as "the
 * session has done nothing yet", which is a claim, and it was false. So the
 * state is named, the reason is stated in one sentence, and there is exactly
 * one thing to do about it.
 *
 * The restart button appears only when the running main process actually
 * answers the channel that performs it. When it does not — which is precisely
 * the older process this screen is complaining about — the user is told to
 * restart Anthill themselves. A button that could not work would be the same
 * mistake in a louder costume.
 */

import { useCallback, useState } from "react";

import type { IpcHealth } from "../ipc-health.js";

export type RestartRequiredProps = {
  health: Extract<IpcHealth, { status: "stale" }>;
  /** What the user was trying to see, e.g. "Live Session". */
  feature: string;
};

export function RestartRequired({ health, feature }: RestartRequiredProps) {
  const [asking, setAsking] = useState(false);
  const [declined, setDeclined] = useState(false);

  const restart = useCallback(async () => {
    setAsking(true);
    setDeclined(false);
    try {
      const restarting = await window.anthill.relaunch();
      // `false` means the user cancelled at the unsaved-changes question. The
      // app is still here, so saying "restarting…" would be a lie.
      if (!restarting) setDeclined(true);
    } catch {
      setDeclined(true);
    } finally {
      setAsking(false);
    }
  }, []);

  return (
    <section className="restart-required" role="alert">
      <h2>{feature} needs a restart</h2>
      <p>{health.detail}</p>

      {health.missing.length > 0 ? (
        <p className="restart-missing">
          Missing on the running process:{" "}
          {health.missing.map((channel) => (
            <code key={channel}>{channel}</code>
          ))}
        </p>
      ) : null}

      {health.canRelaunch ? (
        <div className="restart-actions">
          <button className="primary" onClick={() => void restart()} disabled={asking}>
            {asking ? "Restarting…" : "Restart Anthill"}
          </button>
          {declined ? <span className="hint">Not restarted. Nothing has changed.</span> : null}
        </div>
      ) : (
        <p className="hint">
          Quit Anthill and open it again. Anthill cannot restart itself from here – the
          process that would have to do it is the one that is out of date.
        </p>
      )}

      <p className="restart-note">
        Nothing was observed or lost while this was showing. Anthill was not able to read
        this feature's events, not able to say there were none.
      </p>
    </section>
  );
}
