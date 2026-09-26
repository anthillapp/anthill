/**
 * The plugin connections for one screen, and the install that changes them.
 *
 * Read on arrival and again whenever the window comes back into focus: the
 * things that change the answer — a tool being installed, a session being
 * restarted, a confirmation clicked in another app — all happen outside this
 * window.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { PluginConnection } from "../../shared/ipc.js";

import { pluginCard, type LocalCardState, type PluginCardView } from "./plugin-card.js";

export type Harness = PluginConnection["harness"];

export const HARNESSES: { id: Harness; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export type PluginConnections = {
  views: Record<Harness, PluginCardView>;
  install: (harness: Harness) => Promise<void>;
  check: () => void;
  guide: (harness: Harness) => void;
};

const IDLE: LocalCardState = { kind: "idle" };

export function usePluginConnections(): PluginConnections {
  const [connections, setConnections] = useState<PluginConnection[] | undefined>();
  const [local, setLocal] = useState<Record<Harness, LocalCardState>>({ "claude-code": IDLE, codex: IDLE });
  const alive = useRef(true);

  const check = useCallback(() => {
    Promise.resolve()
      .then(() => window.anthill.pluginConnections())
      .then((next) => {
        if (alive.current) setConnections(next);
      })
      // A failed read leaves the last answer standing rather than claiming a new one.
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    alive.current = true;
    check();
    window.addEventListener("focus", check);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", check);
    };
  }, [check]);

  const install = useCallback(
    async (harness: Harness) => {
      setLocal((prev) => ({ ...prev, [harness]: { kind: "installing" } }));
      const result = await window.anthill
        .pluginInstall(harness)
        .catch((error: unknown) => ({ ok: false as const, changed: false, error: String((error as Error)?.message ?? error) }));
      if (!alive.current) return;
      setLocal((prev) => ({ ...prev, [harness]: result.ok ? { kind: "installed" } : { kind: "failed", result } }));
      check();
    },
    [check],
  );

  // "Check again" is the author saying they restarted the session: from here
  // on the card goes by what the check finds.
  const checkAgain = useCallback(() => {
    setLocal((prev) => ({
      "claude-code": prev["claude-code"].kind === "installed" ? IDLE : prev["claude-code"],
      codex: prev.codex.kind === "installed" ? IDLE : prev.codex,
    }));
    check();
  }, [check]);

  const guide = useCallback((harness: Harness) => {
    void window.anthill.pluginGuide(harness).catch(() => undefined);
  }, []);

  const views = Object.fromEntries(
    HARNESSES.map(({ id, label }) => [
      id,
      pluginCard(
        connections?.find((item) => item.harness === id),
        local[id],
        label,
      ),
    ]),
  ) as Record<Harness, PluginCardView>;

  return { views, install, check: checkAgain, guide };
}
