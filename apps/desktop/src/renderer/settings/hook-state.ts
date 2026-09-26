/**
 * What Settings can honestly claim about a harness's Live observation hooks.
 *
 * Shared by the Live observation page, which manages the hooks, and the Coding
 * tools page, which lists them as one fact per tool (ANT-135) — so the two
 * pages cannot word the same machine differently.
 */

import type { ObservationHarnessSetup } from "../../shared/ipc.js";

/**
 * What the card can honestly claim about a harness's hooks.
 *
 * Each state is a different claim. Entries in a config file are not
 * hooks that run (ANT-23), and hooks that run are not hooks the harness calls
 * (ANT-42) — Codex had six entries, a handler that ran on demand and, across
 * eight sessions, not one event, while the card said Enabled.
 */
export type HookState = "enabled" | "silent" | "broken" | "available" | "needs-trust" | "disabled" | "unknown" | "ready";

export function hookState(harness: ObservationHarnessSetup): HookState {
  if (!harness.hookEntriesPresent) return "available";
  if (!harness.hookInstalled) return "broken";
  if (harness.id === "codex") {
    switch (harness.codexHooks?.state) {
      case "needs-trust": return "needs-trust";
      case "disabled": return "disabled";
      case "ready": return harness.hookLastEventAt ? "enabled" : "ready";
      default: return "unknown";
    }
  }
  return harness.hookLastEventAt ? "enabled" : "silent";
}

export const CHIP: Record<HookState, { label: string; tone: "on" | "quiet" | "off" }> =
  {
    enabled: { label: "Enabled", tone: "on" },
    "needs-trust": { label: "Needs permission", tone: "quiet" },
    disabled: { label: "Disabled in Codex", tone: "quiet" },
    unknown: { label: "Not verified", tone: "quiet" },
    ready: { label: "Ready for next session", tone: "on" },
    silent: { label: "Not seen firing", tone: "quiet" },
    broken: { label: "Not working", tone: "quiet" },
    available: { label: "Available", tone: "off" },
  };
