/**
 * Whether to ask the person about Anthill's hooks, and what (ANT-138).
 *
 * One rule for both ways a Codex workflow starts — handed over from Anthill,
 * or `$anthill` in a Codex session that is already open — so the two cannot
 * disagree about the same machine.
 *
 * - **Nothing to ask** when Codex has the hooks installed, enabled and trusted,
 *   or when a hook of Anthill's has already fired in this very session.
 * - **Connect** when they are missing, broken, or point at a runtime this
 *   Anthill did not install. Installing waits for a yes.
 * - **Trust** when Codex holds them but has not trusted them (or they are
 *   switched off). Only the person can grant that, in Codex's own `/hooks`.
 * - **Hint** when the check could not say. That is never read as "not
 *   trusted": the person is told what Anthill could not see and carries on
 *   with basic progress.
 *
 * "Continue with basic progress" is remembered against a fingerprint of the
 * exact commands this Anthill would install. The question comes back when
 * those commands change — a moved app, a different runtime — because the
 * answer was about the old ones. It also comes back after trust is revoked
 * or the hooks are switched off, because an approval seen since the decline
 * clears it.
 */

import { createHash } from "node:crypto";

import type { CodexHookStatus, ObservationPrompt } from "../../shared/ipc.js";

/** The exact commands a decline or an approval was about. */
export function hookFingerprint(commands: readonly { command: string; event: string }[]): string {
  const canonical = [...commands]
    .map(({ command, event }) => `${event}\u0000${command}`)
    .sort()
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type HookPrefs = { declinedAt?: string | null; declinedFor?: string | null };

/**
 * Whether the person already said "basic progress" to these exact hooks.
 *
 * A decline written before fingerprints existed carries none; it is honoured
 * rather than dropped, since asking again the day after someone said no is
 * the thing this exists to prevent.
 */
export function isDeclined(prefs: HookPrefs | undefined, fingerprint: string): boolean {
  if (!prefs?.declinedAt) return false;
  return prefs.declinedFor == null || prefs.declinedFor === fingerprint;
}

export function hookPrompt(input: {
  cliAvailable: boolean;
  installProblem?: string | undefined;
  entriesPresent: boolean;
  /** Entries present and the handler they name runs. */
  installed: boolean;
  usesCurrentRuntime: boolean;
  codexState?: CodexHookStatus["state"] | undefined;
  confirmedInSession?: boolean | undefined;
  declined: boolean;
}): ObservationPrompt | null {
  if (!input.cliAvailable || input.installProblem) return null;
  if (input.confirmedInSession) return null;
  if (input.declined) return null;
  if (!input.entriesPresent || !input.installed || !input.usesCurrentRuntime) return "connect";
  switch (input.codexState) {
    case "ready":
      return null;
    case "needs-trust":
    case "disabled":
      return "trust";
    default:
      // "not-loaded", "unknown", or no answer at all: Anthill could not see
      // enough to say the hooks are not trusted, and must not claim it.
      return "hint";
  }
}
