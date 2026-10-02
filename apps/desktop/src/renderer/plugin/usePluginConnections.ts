/**
 * The plugin connections for one screen, and the install that changes them.
 *
 * Read on arrival and again whenever the window comes back into focus: the
 * things that change the answer — a tool being installed, a session being
 * restarted, a confirmation clicked in another app — all happen outside this
 * window.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CHECKED_PLUGIN_HARNESSES, PLUGIN_HARNESS_INFO, type CheckedPluginHarness } from "@anthill/workflow";

import type { PluginConnection } from "../../shared/ipc.js";

import { pluginCard, type LocalCardState, type PluginCardView } from "./plugin-card.js";

export type Harness = CheckedPluginHarness;

export const HARNESSES: { id: Harness; label: string }[] = CHECKED_PLUGIN_HARNESSES.map((id) => ({
  id,
  label: PLUGIN_HARNESS_INFO[id].label,
}));

export type PluginConnections = {
  views: Record<Harness, PluginCardView>;
  install: (harness: Harness) => Promise<void>;
  check: () => void;
  guide: (harness: Harness) => void;
};

const IDLE: LocalCardState = { kind: "idle" };

/** One value per plugin harness. */
function perHarness<T>(make: (id: Harness) => T): Record<Harness, T> {
  return Object.fromEntries(CHECKED_PLUGIN_HARNESSES.map((id) => [id, make(id)])) as Record<Harness, T>;
}

export function usePluginConnections(): PluginConnections {
  const [connections, setConnections] = useState<PluginConnection[] | undefined>();
  const [local, setLocal] = useState<Record<Harness, LocalCardState>>(() => perHarness(() => IDLE));
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
    setLocal((prev) => perHarness((id) => (prev[id].kind === "installed" ? IDLE : prev[id])));
    check();
  }, [check]);

  const guide = useCallback((harness: Harness) => {
    void window.anthill.pluginGuide(harness).catch(() => undefined);
  }, []);

  const views = perHarness((id) =>
    pluginCard(
      connections?.find((item) => item.harness === id),
      local[id],
      PLUGIN_HARNESS_INFO[id].label,
    ),
  );

  return { views, install, check: checkAgain, guide };
}
