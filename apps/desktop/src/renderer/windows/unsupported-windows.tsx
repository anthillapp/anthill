/**
 * An unsupported Windows build, said once and then kept in view (ANT-154).
 *
 * Anthill is not supported on Windows yet, and it does not block it either:
 * a source build runs, and the person running it is told — before relying on
 * it — that it is unsupported, that some things may not work, that nothing is
 * guaranteed, and that they may carry on. That is the gate. Carrying on does
 * not make the build supported; it only records that the gate was read, so a
 * small grey chip stays in the chrome of every screen afterwards.
 *
 * The acknowledgement is per machine and per version: a new build is a new
 * unvalidated build, so the gate comes back when the version changes.
 *
 * Tone is part of the behaviour: this is a support boundary, not an error.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const ACK_KEY = "anthill.windows-acknowledged";

export type UnsupportedWindows = {
  /** This shell runs on native Windows. */
  windows: boolean;
  /** The gate is showing: Windows, and this version not yet acknowledged. */
  gate: boolean;
  /** Continue experimentally. */
  acknowledge: () => void;
  /** Open the Windows issue form. */
  report: () => void;
};

const NOT_WINDOWS: UnsupportedWindows = {
  windows: false,
  gate: false,
  acknowledge: () => undefined,
  report: () => undefined,
};

const Context = createContext<UnsupportedWindows>(NOT_WINDOWS);

export function acknowledgedVersion(): string | null {
  try {
    return window.localStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
}

function remember(version: string): void {
  try {
    window.localStorage.setItem(ACK_KEY, version);
  } catch {
    // Without storage the gate simply shows again next time, which is the
    // safe way round for a notice about an unsupported build.
  }
}

export function reportWindowsIssue(): void {
  void window.anthill.openLink?.("windowsIssue");
}

/**
 * Reads the platform once from the shell. Everything else in the app asks
 * this, so there is one answer to "is this the unsupported Windows build".
 */
export function UnsupportedWindowsProvider({
  children,
  version = __ANTHILL_VERSION__,
}: {
  children: ReactNode;
  version?: string;
}) {
  const [windows, setWindows] = useState(false);
  const [acknowledged, setAcknowledged] = useState(() => acknowledgedVersion() === version);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => window.anthill.capabilities())
      .then((capabilities) => {
        if (live) setWindows(capabilities.platform === "win32");
      })
      // A shell that cannot say is taken at its word: nothing to announce.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const acknowledge = useCallback(() => {
    remember(version);
    setAcknowledged(true);
  }, [version]);

  const value = useMemo<UnsupportedWindows>(
    () => ({ windows, gate: windows && !acknowledged, acknowledge, report: reportWindowsIssue }),
    [windows, acknowledged, acknowledge],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useUnsupportedWindows(): UnsupportedWindows {
  return useContext(Context);
}

/**
 * The chip: grey, a dot, and the words. It opens the Windows issue form, and
 * it is neither an error nor dismissible. Renders nothing off Windows, and
 * nothing while the gate is still up — the gate is already saying it.
 */
export function UnsupportedWindowsChip({ skin }: { skin: "on-dark" | "on-light" }) {
  const { windows, gate, report } = useUnsupportedWindows();
  if (!windows || gate) return null;
  return (
    <button
      type="button"
      className={`win-chip ${skin}`}
      title="This is an unsupported, experimental Windows build. Click to report a Windows issue."
      onClick={report}
    >
      <i aria-hidden="true" />
      Unsupported Windows build
    </button>
  );
}
