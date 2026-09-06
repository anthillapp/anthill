/**
 * Finding out whether the process on the other end of IPC is the one this
 * screen was written for.
 *
 * Anthill's three halves load from three places and can be three different
 * ages. The renderer is always current. The preload is read off disk every time
 * a window loads, so a rebuild changes it under a running app. The main process
 * is loaded once at launch and then never again — so a renderer can end up
 * asking a months-old main process for a channel that did not exist when it
 * started.
 *
 * Left alone that is invisible: `invoke` on an unregistered channel rejects,
 * a rejection nobody awaited is swallowed, and the feature shows an empty
 * state that looks exactly like "nothing has happened yet". This module turns
 * that into an answer a screen can act on, before it subscribes to anything.
 *
 * Deliberately general. It knows nothing about Live Session; a caller names the
 * channels it needs and gets told whether they are there.
 */

import { useEffect, useState } from "react";
import { IPC_CONTRACT, type IpcCapabilities } from "../shared/ipc.js";

/** Which half is behind, which decides what the user is told to do about it. */
export type StaleSide =
  /** `window.anthill` is missing entirely — no preload ran. */
  | "bridge"
  /** The preload on disk is older than this renderer. */
  | "preload"
  /** The running main process is older than the preload that reached it. */
  | "main";

export type IpcHealth =
  | { status: "checking" }
  | { status: "ok"; capabilities: IpcCapabilities; canRelaunch: boolean }
  | {
      status: "stale";
      side: StaleSide;
      /** Channels the caller asked for that the running process does not serve. */
      missing: string[];
      /** One sentence, safe to show as-is. */
      detail: string;
      /** Whether main can restart itself, or the user has to do it. */
      canRelaunch: boolean;
    };

const RESTART_HINT = "Live Session needs an Anthill restart to enable this feature.";

/**
 * Ask once, on mount, whether the required channels are actually served.
 *
 * `required` is read on the first render only — the set a screen needs does not
 * change while it is open, and re-probing on every render would be noise.
 */
export function useIpcHealth(required: readonly string[]): IpcHealth {
  const [health, setHealth] = useState<IpcHealth>({ status: "checking" });

  useEffect(() => {
    let live = true;
    const settle = (next: IpcHealth) => {
      if (live) setHealth(next);
    };

    void checkIpcHealth(required).then(settle, (error: unknown) =>
      settle({
        status: "stale",
        side: "main",
        missing: [...required],
        detail:
          error instanceof Error ? `${RESTART_HINT} (${error.message})` : RESTART_HINT,
        canRelaunch: false,
      }),
    );

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return health;
}

/** The check itself, without React, so it can be tested directly. */
export async function checkIpcHealth(required: readonly string[]): Promise<IpcHealth> {
  const api = window.anthill as Partial<typeof window.anthill> | undefined;

  if (!api) {
    return {
      status: "stale",
      side: "bridge",
      missing: [...required],
      detail: "Anthill's window bridge did not load. Quit Anthill and open it again.",
      canRelaunch: false,
    };
  }

  // A preload older than this renderer has no `capabilities` at all, so asking
  // for it would throw rather than reject. That absence is the answer.
  if (typeof api.capabilities !== "function") {
    return {
      status: "stale",
      side: "preload",
      missing: [...required],
      detail: `${RESTART_HINT} The window is running an older bridge than the app.`,
      canRelaunch: false,
    };
  }

  let capabilities: IpcCapabilities;
  try {
    capabilities = await api.capabilities();
  } catch {
    // The channel is not registered, which means main predates it. This is the
    // case that used to be silent, and it is the common one in development.
    return {
      status: "stale",
      side: "main",
      missing: [...required],
      detail: `${RESTART_HINT} Anthill's background process started before this feature existed.`,
      canRelaunch: false,
    };
  }

  const canRelaunch = capabilities.channels.includes("app:relaunch");
  const missing = required.filter((channel) => !capabilities.channels.includes(channel));

  if (missing.length > 0 || capabilities.contract < (api.contract ?? IPC_CONTRACT)) {
    return {
      status: "stale",
      side: "main",
      missing,
      detail: `${RESTART_HINT} Anthill's background process is running an older version of this feature.`,
      canRelaunch,
    };
  }

  return { status: "ok", capabilities, canRelaunch };
}
