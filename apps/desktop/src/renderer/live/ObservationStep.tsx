/**
 * Step 2 of the handover: offering to watch the session about to start.
 *
 * Observation hooks have the same deadline the agent files have. Both are read
 * by the CLI when its session starts, so anything written afterwards is
 * invisible to it — which is why this belongs in the handover and not beside
 * Save, where a button gave no hint of a deadline and asked the author to
 * configure something whose purpose only becomes clear here.
 *
 * The state is shown for the harness this handover is for, and no other. Two
 * CLIs' worth of status on one screen is noise the flow already knows the
 * answer to.
 *
 * The tone is the honesty channel, not decoration. Green appears only where
 * Anthill can actually report progress; amber covers both "nothing has come
 * through yet" and "this tool writes less than step detail needs", because
 * neither may be dressed as success; red is only for a failure Anthill caused;
 * and a CLI that is not installed is flat grey, because that is neither a
 * warning nor a fault.
 */

import { useState } from "react";

import type { ObservationHarnessSetup } from "../../shared/ipc.js";

/** What Anthill can say about watching this harness. */
export type ObservationState =
  | "unconfigured"
  | "ready"
  | "silent"
  | "limited"
  | "failed"
  | "passive"
  | "unavailable";

type Tone = "ok" | "unsure" | "bad" | "flat";

type Face = {
  title: string;
  chip: string;
  tone: Tone;
  /**
   * Whether the primary button installs something.
   *
   * Deliberately separate from "is this state settled", and the separation is
   * load-bearing. An earlier build drove the primary off a single settled
   * predicate — `ready | silent | limited` — which dropped `unavailable`
   * through to the installing branch: on a machine where Anthill had just said
   * the CLI was not found, a button reading `Continue` installed hooks and
   * flipped the panel to "ready". It also put two buttons reading `Continue`
   * side by side, where the primary did not continue and the secondary did.
   *
   * Advancing and installing are different acts, so they are different
   * predicates.
   */
  install: boolean;
  primary: string;
  note: string;
};

export const OBSERVATION_FACE: Record<ObservationState, Face> = {
  unconfigured: {
    title: "Live progress is not set up yet",
    chip: "Not set up",
    tone: "unsure",
    install: true,
    primary: "Enable Live Observation",
    note: "Without hooks, Anthill can still hand over the workflow — it just will not be able to show you what the session is doing.",
  },
  ready: {
    title: "Live Observation is ready",
    chip: "Ready",
    tone: "ok",
    install: false,
    primary: "Continue",
    note: "Hooks are installed for this tool. Nothing to do — the workflow will show progress once the session starts.",
  },
  silent: {
    title: "Installed, but nothing has come through yet",
    chip: "Untested",
    tone: "unsure",
    install: false,
    primary: "Continue",
    note: "The hooks are in place and no session has written through them yet. That is expected before your first run; if it stays quiet afterwards, Settings can repair it.",
  },
  limited: {
    title: "Limited progress only",
    chip: "Limited",
    tone: "unsure",
    install: false,
    primary: "Continue",
    note: "This tool writes less than Anthill needs for step-level detail. You will see the session running and what it finished, but not every step it passed through.",
  },
  failed: {
    title: "Could not set up Live Observation",
    chip: "Failed",
    tone: "bad",
    install: true,
    primary: "Retry",
    note: "Your own hooks were left untouched, and handing over still works — you just will not see progress.",
  },
  /**
   * A tool with no hook mechanism. There is nothing to install and nothing to
   * fail: Anthill reads the session file the tool writes on this machine. The
   * row must not offer an install, because there is no hook to write — that
   * would be a button that does nothing.
   */
  passive: {
    title: "Live progress is on — nothing to set up",
    chip: "Passive",
    tone: "ok",
    install: false,
    primary: "Continue",
    note: "This tool has no hook mechanism, so there is nothing to install. Anthill reads the session file it writes on this machine and shows progress once the session starts.",
  },
  unavailable: {
    title: "This CLI was not found on this machine",
    chip: "Unavailable",
    tone: "flat",
    install: false,
    primary: "Continue",
    note: "Anthill reads what an installed CLI writes locally, so there is nothing to hook into. Install it and sign in, then set this up from Settings.",
  },
};

/**
 * Which of the six this harness is in.
 *
 * `limited` is not produced here. It is a claim about a tool writing less than
 * step-level detail, and nothing in the app measures that yet — inventing a
 * rule for it would be exactly the kind of guess the tone column exists to
 * prevent. The state is implemented so the panel can show it the day there is
 * a signal to drive it.
 */
export function observationState(
  harness: ObservationHarnessSetup | undefined,
  justFailed = false,
): ObservationState {
  if (!harness || !harness.cliAvailable) return "unavailable";
  if (justFailed) return "failed";
  if (!harness.hookEntriesPresent) return "unconfigured";
  // Entries written and the command will not run: Anthill's own install is
  // broken, which is a failure Anthill caused and can retry.
  if (!harness.hookInstalled) return "failed";
  return harness.hookLastEventAt ? "ready" : "silent";
}

export type ObservationStepProps = {
  label: string;
  harness: ObservationHarnessSetup | undefined;
  state: ObservationState;
  /** The reason the last install attempt failed, when there was one. */
  error?: string | undefined;
  busy: boolean;
  onInstall: () => void;
};

export function ObservationStep({
  label,
  harness,
  state,
  error,
  busy,
  onInstall,
}: ObservationStepProps) {
  const [techOpen, setTechOpen] = useState(false);
  const face = OBSERVATION_FACE[state];

  return (
    <section className="handover-panel">
      <h2>See this workflow progress live in Anthill</h2>
      {/* The boundary before anything else, because everything below is a
          question about installing something on this machine. */}
      <p>
        {state === "passive"
          ? `Anthill watches ${label} by reading the session file it writes on this machine — there is nothing to install, ${label} has no hook mechanism. `
          : `Anthill can install local observation hooks for ${label}. `}
        It only observes the session you start yourself — it does not run it, control it, or
        answer it.
      </p>

      <div className={`state-panel tone-${face.tone}`}>
        <div className="state-panel-head">
          <span className="state-dot" aria-hidden="true" />
          <span className="state-title">{face.title}</span>
          <span className="state-chip">{face.chip}</span>
        </div>
        <p className="state-note">
          {state === "failed" && error ? `${error} ` : ""}
          {face.note}
        </p>
      </div>

      {busy ? <p className="hint">Writing the hook entries…</p> : null}

      {/* There are no hook entries to show for a passive tool, so the whole
          technical-details section is hidden rather than a wall of dashes. */}
      {state !== "passive" ? (
        <>
          <button
            type="button"
            className="tech-toggle"
            aria-expanded={techOpen}
            onClick={() => setTechOpen((open) => !open)}
          >
            <span className="tech-caret" aria-hidden="true">
              ›
            </span>
            Technical details
          </button>
          {techOpen ? (
            <dl className="tech-rows">
              <dt>Config file</dt>
              <dd>
                <code>{harness?.configPath ?? "—"}</code>
              </dd>
              <dt>Handler</dt>
              <dd>
                <code>{harness?.hookHandlerPath ?? "—"}</code>
              </dd>
              <dt>Entries</dt>
              <dd>
                {harness ? `${harness.hookCommands.length} owned by Anthill` : "—"}
                {harness?.hookLastEventAt ? ` · last event ${harness.hookLastEventAt}` : ""}
              </dd>
              <dt>Events</dt>
              <dd>{harness ? harness.eventCategories.join(", ") : "—"}</dd>
              <dt>Changes</dt>
              <dd>{harness ? harness.changes.join(" ") : "—"}</dd>
            </dl>
          ) : null}
        </>
      ) : null}

      {/* The primary lives in the modal's footer; this is the one case where
          the step itself offers the action, so a reader who has opened the
          details does not have to travel back down to act on them. */}
      {face.install ? (
        <button type="button" className="primary tech-install" disabled={busy} onClick={onInstall}>
          {busy ? "Working…" : face.primary}
        </button>
      ) : null}
    </section>
  );
}
