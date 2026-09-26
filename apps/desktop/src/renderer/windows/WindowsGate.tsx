/**
 * The one-time notice a Windows source build shows before normal use (ANT-154).
 *
 * Over whatever screen opens, inside the window, and modal. It says the four
 * things the person has to know before relying on the build — unsupported,
 * some things may not work, no guarantee, and that they may carry on — in a
 * tone that is a boundary, not an alarm: grey, no warning icon, no red but
 * the one primary action. Continue is where focus lands.
 */

import { useEffect, useId, useRef, useState } from "react";

import { useUnsupportedWindows } from "./unsupported-windows.js";

export function WindowsGate() {
  const { gate, acknowledge, report } = useUnsupportedWindows();
  const title = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  // Exit quits the desktop app. The CLI's page has nothing to quit, so it
  // offers Continue and Report only.
  const [canQuit, setCanQuit] = useState(false);

  useEffect(() => {
    if (!gate) return;
    continueRef.current?.focus();
    let live = true;
    Promise.resolve()
      .then(() => window.anthill.capabilities())
      .then((capabilities) => {
        if (live) setCanQuit(capabilities.channels.includes("app:quit") && typeof window.anthill.quit === "function");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gate]);

  if (!gate) return null;

  return (
    <div className="win-gate">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={title}>
        <span className="kicker">
          <i aria-hidden="true" />
          Experimental source build
        </span>
        <h2 id={title}>Windows support is coming soon</h2>
        <p>
          You are running Anthill built from source on Windows. It hasn&rsquo;t been validated
          here yet, so some features, integrations and local storage may not work correctly.
        </p>
        <ul>
          <li>Unsupported – no compatibility, data-safety or support guarantee.</li>
          <li>Anything known not to work is turned off and says why.</li>
          <li>You can keep going if you accept that.</li>
        </ul>
        <div className="actions">
          <button ref={continueRef} type="button" className="continue" onClick={acknowledge}>
            Continue experimentally
          </button>
          <button type="button" className="report" onClick={report}>
            Report a Windows issue
          </button>
          {canQuit ? (
            <button type="button" className="exit" onClick={() => void window.anthill.quit?.()}>
              Exit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
