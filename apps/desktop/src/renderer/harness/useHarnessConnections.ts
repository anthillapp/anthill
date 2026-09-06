/**
 * Which coding tools this machine has, and whether anyone is signed in.
 *
 * One question, asked in one place. The prompt-to-workflow sheet asked it
 * first; the agent editor needs the same answer, and a second detector would be
 * a second thing to keep true — with the failure mode that the two screens
 * disagree about the author's own computer.
 *
 * A tool's status lives here, in its own state. Detection *seeds* it and the
 * setup sheet *writes* it; nothing derives it from whether a sheet is open,
 * which would mean closing the sheet silently disconnected the tool. The two
 * are different facts with different lifetimes: a connection is a fact about
 * the machine, and a sheet is a thing on screen.
 *
 * Nothing here connects anything. It runs `--version` and the CLI's own status
 * command, both read-only, and opens a terminal on the CLI's own login command
 * when asked. Anthill never handles the credentials: the browser flow and the
 * account are the author's, and this could not do it for them if it wanted to.
 */

import { useCallback, useEffect, useState } from "react";

import type { InterpreterId } from "@anthill/workflow";

import type { InterpreterInfo } from "../../shared/ipc.js";

/**
 * What a tool is, as the cards read it.
 *
 * `off` is "nothing has been claimed yet", not "no". It is what a tool is
 * before anyone has looked, and it never carries a colour that suggests a
 * verdict.
 */
export type ToolStatus =
  | "off"
  | "checking"
  | "on"
  | "not-installed"
  | "signed-out"
  | "failed";

export type HarnessConnection = {
  id: InterpreterId;
  status: ToolStatus;
  /** What detection last said, when it has said anything. */
  info?: InterpreterInfo;
};

/**
 * Detection's verdict, and only where there is one.
 *
 * `signedIn` absent means the CLI would not answer — an unfamiliar version, a
 * changed output format. That is not a no: a tool is not held back on the
 * strength of a question that could not be asked, so it counts as connected and
 * the sheet says what is and is not being claimed.
 */
function statusOf(info: InterpreterInfo): ToolStatus {
  if (!info.available) return "not-installed";
  if (info.signedIn === false) return "signed-out";
  return "on";
}

export type HarnessConnections = ReturnType<typeof useHarnessConnections>;

const IDS: InterpreterId[] = ["claude-code", "codex"];

export function useHarnessConnections() {
  const [tools, setTools] = useState<Record<InterpreterId, HarnessConnection>>(() =>
    Object.fromEntries(IDS.map((id) => [id, { id, status: "off" as ToolStatus }])) as Record<
      InterpreterId,
      HarnessConnection
    >,
  );
  /** Whether the first answer has arrived. Nothing is claimed before it. */
  const [looked, setLooked] = useState(false);

  const look = useCallback(async (only?: InterpreterId) => {
    setTools((current) => {
      const next = { ...current };
      for (const id of IDS) {
        if (only && id !== only) continue;
        next[id] = { ...next[id], status: "checking" };
      }
      return next;
    });

    const found = await window.anthill.detectInterpreters().catch(() => undefined);
    setLooked(true);
    setTools((current) => {
      const next = { ...current };
      for (const id of IDS) {
        if (only && id !== only) continue;
        const info = found?.find((item) => item.id === id);
        // A detection that could not run at all is a failure of Anthill's, not
        // a verdict about the tool — so it says so rather than reporting the
        // tool as missing.
        next[id] = info
          ? { id, status: statusOf(info), info }
          : { ...next[id], status: found ? "not-installed" : "failed" };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void look();
  }, [look]);

  /**
   * Coming back to Anthill is the signal that something may have changed.
   *
   * Signing in takes the author out of this window and into a terminal and a
   * browser; returning is exactly the moment the old answer is most likely to
   * be stale, and re-asking costs one short process. Without this, a screen
   * would go on saying "signed out" after the author had just signed in,
   * telling them their own work did not count.
   */
  useEffect(() => {
    const onFocus = () => void look();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [look]);

  const of = useCallback((id: InterpreterId): HarnessConnection => tools[id], [tools]);

  return {
    of,
    looked,
    /** Re-ask about one tool, or about all of them. */
    recheck: look,
  };
}

/** Whether a tool is usable — the one question the model field turns on. */
export function isConnected(connection: HarnessConnection): boolean {
  return connection.status === "on";
}
