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

import { pluginVerdict } from "../settings/plugin-steps.js";

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

/** How often the cards ask again while Anthill is updating a plugin by itself. */
const UPDATE_POLL_MS = 3_000;

/** One value per plugin harness. */
function perHarness<T>(make: (id: Harness) => T): Record<Harness, T> {
  return Object.fromEntries(CHECKED_PLUGIN_HARNESSES.map((id) => [id, make(id)])) as Record<Harness, T>;
}

export function usePluginConnections(): PluginConnections {
  const [connections, setConnections] = useState<PluginConnection[] | undefined>();
  const [local, setLocal] = useState<Record<Harness, LocalCardState>>(() => perHarness(() => IDLE));
  const alive = useRef(true);
  // Read by `install`, which has to know whether the click is an update.
  const latest = useRef<PluginConnection[] | undefined>();
  latest.current = connections;

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

  // Anthill updating a plugin as it starts (ANT-282) finishes on its own,
  // with nothing in this window to bring it back into focus: while one is
  // running, ask again every few seconds so the card moves on when it does.
  const updating = connections?.some((item) => item.status.autoUpdate?.state === "updating") ?? false;
  useEffect(() => {
    if (!updating) return;
    const timer = window.setTimeout(check, UPDATE_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [updating, connections, check]);

  const install = useCallback(
    async (harness: Harness) => {
      // Main updates a plugin that is behind instead of installing it; the
      // card says which it is doing, and which one failed.
      const current = latest.current?.find((item) => item.harness === harness)?.status;
      const update = current ? pluginVerdict(current) === "update" : false;
      setLocal((prev) => ({ ...prev, [harness]: { kind: "installing", update } }));
      const result = await window.anthill
        .pluginInstall(harness)
        .catch((error: unknown) => ({ ok: false as const, changed: false, error: String((error as Error)?.message ?? error) }));
      if (!alive.current) return;
      setLocal((prev) => ({
        ...prev,
        [harness]: result.ok
          ? result.confirm
            ? { kind: "confirming" }
            : { kind: "installed", update }
          : { kind: "failed", result, update },
      }));
      check();
    },
    [check],
  );

  // "Check again" is the author saying they restarted the session: from here
  // on the card goes by what the check finds.
  const checkAgain = useCallback(() => {
    setLocal((prev) => perHarness((id) => (prev[id].kind === "installed" || prev[id].kind === "confirming" ? IDLE : prev[id])));
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
