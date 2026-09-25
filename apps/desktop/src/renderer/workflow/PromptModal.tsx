/**
 * The handover: the one place a workflow becomes something you can paste.
 *
 * Anthill does not run the workflow. This screen prepares files, optionally
 * installs local observation hooks, and hands over a single prompt the author
 * copies, pastes into their own Claude Code, Codex, or Pi, and starts
 * themselves.
 * After that Anthill only observes, by reading what the CLI writes on this
 * machine.
 *
 * Three steps, because three things have to happen in an order and only one of
 * them is the copy:
 *
 * 1. **Files.** A harness fixes its list of callable agents when its session
 *    starts, so files the session writes for itself are not callable in it
 *    (ANT-22). The copy is the last moment they can be in place.
 * 2. **Live observation.** The same deadline, for the same reason: hooks are
 *    read at start-up. This used to be a button beside Save, which gave no
 *    hint of a deadline and asked the author to configure something whose
 *    purpose only becomes clear here.
 * 3. **Hand over.** The prompt, the marker, and then waiting — because
 *    copying is not starting, and the screen must not pretend otherwise.
 *
 * Two rules run through all of it, and if either breaks the flow is lying
 * about what Anthill knows: copying the prompt never reports a live session,
 * and a CLI that was not found is never told it is ready.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ValidationResult, Workflow } from "@anthill/workflow-schema";
import { HARNESS_PROFILES, WorkflowCompileError, runRoot } from "@anthill/workflow";
import {
  MARKER_VERSION,
  buildBootstrapPrompt,
  workflowSteps,
  newNonce,
  newRunId,
  type BootstrapResult,
  type MarkerCli,
  type RunMarker,
} from "@anthill/live";

import type { ObservationHarnessSetup } from "../../shared/ipc.js";
import {
  OBSERVATION_FACE,
  ObservationStep,
  observationState,
  type ObservationState,
} from "../live/ObservationStep.js";

import { useSetupPoll } from "../live/use-setup-poll.js";

import { interpreterLogo } from "./interpreter-logos.js";
import { agentFileExtension } from "./agent-file-name.js";

export type PromptModalProps = {
  workflow: Workflow;
  validation: ValidationResult;
  onClose: () => void;
  /** Called after a copy registers a run, so the header can show it at once. */
  onObserving?: () => void;
  /**
   * Remember the repository the agent files were written into.
   *
   * The modal does not own the workflow, so the folder it learns has to be
   * handed back to whoever does, or the author names it again every time.
   */
  onRunRoot?: (root: string) => void;
};

function randomHex(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A stable fingerprint of the copied prompt.
 *
 * Stored instead of the prompt itself: it is enough to tell one copy from
 * another, and the prompt can be long and is the user's own work.
 */
async function hashPrompt(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mintMarker(workflow: Workflow, cli: MarkerCli): RunMarker {
  return {
    runId: newRunId(randomHex),
    nonce: newNonce(randomHex),
    ...(workflow.id ? { workflowId: workflow.id } : {}),
    cli,
    promptVersion: MARKER_VERSION,
    issuedAt: new Date().toISOString(),
  };
}

/** What the folder receipt is saying, which is also what the footer says. */
type Placement = "none" | "pending" | "written" | "failed";

/** Which of the three the author is on. */
type Step = 1 | 2 | 3;

const STEP_NAMES: Record<Step, string> = { 1: "1 Files", 2: "2 Live", 3: "3 Hand over" };

export function PromptModal({
  workflow,
  validation,
  onClose,
  onObserving,
  onRunRoot,
}: PromptModalProps) {
  const cli: MarkerCli =
    workflow.target === "codex" ? "codex" : workflow.target === "pi" ? "pi" : "claude-code";
  const harnessProfile = HARNESS_PROFILES[workflow.target ?? "claude-code"];

  /**
   * Whether the Codex on this machine will actually read the agent files.
   *
   * Asked here rather than assumed, and only where it matters: handing over to
   * a CLI that predates project-scoped custom agents means every step runs on
   * whatever model the session started with, and that is worth knowing *before*
   * the prompt is pasted rather than after the run looks wrong.
   */
  const [codexReadsAgents, setCodexReadsAgents] = useState<boolean | undefined>();
  useEffect(() => {
    if (workflow.target !== "codex") return;
    let live = true;
    void window.anthill
      .codexModels()
      .then((found) => {
        // `unknown` leaves it unsaid — and unsaid means `undefined`, not
        // `false`: warning on a question that could not be answered would send
        // people to update software that is already fine.
        if (!live || !found || found.agentSupport === "unknown") return;
        setCodexReadsAgents(found.agentSupport === "supported");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workflow.target]);

  const [marker, setMarker] = useState<RunMarker>(() => mintMarker(workflow, cli));
  const [folder, setFolder] = useState<string | null>(() => runRoot(workflow) ?? null);
  const [placement, setPlacement] = useState<Placement>("none");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Whether a failed export left the folder as it was. See ANT-100. */
  const [rolledBack, setRolledBack] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the shell serving this renderer is the CLI.
   *
   * Only the CLI shell has the `anthill` binary the harness can reach, so
   * only there does the prompt tell the harness to report through the CLI
   * instead of printing marker lines. A shell that cannot be asked is
   * treated as the desktop: the printed markers are the channel that works
   * everywhere.
   *
   * Unknown until the capability query answers: a copy before the answer
   * would hand over a prompt built for the wrong shell, so the Copy button
   * waits for it.
   */
  const [reportViaCli, setReportViaCli] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.anthill
      .capabilities()
      .then((caps) => {
        if (live) setReportViaCli(caps.shell === "cli");
      })
      .catch(() => {
        // A shell that cannot be asked is treated as the desktop: the
        // printed markers are the channel that works everywhere.
        if (live) setReportViaCli(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /** The harness's observation setup, once main has been asked. */
  const [setup, setSetup] = useState<ObservationHarnessSetup | undefined>();
  const [installFailed, setInstallFailed] = useState<string | undefined>();
  const [installing, setInstalling] = useState(false);

  /**
   * Whether a session Anthill can be sure of has turned up.
   *
   * Only ever set from a snapshot that names this run. The copy never sets it,
   * which is the whole point: a prompt on the clipboard is not a session.
   */
  const [detection, setDetection] = useState<"waiting" | "ambiguous">("waiting");

  /**
   * Pi has no hook mechanism, so its observation is passive: there is nothing
   * to install, and Anthill reads the session file pi writes on this machine.
   * The hook-based setup status never names pi, so pi's state is not derived
   * from it — it is `passive` on its own, and it is watchable, which is what
   * lets a pi run's handover close and go live.
   */
  const observation: ObservationState =
    cli === "pi" ? "passive" : observationState(setup, installFailed !== undefined);
  const face = OBSERVATION_FACE[observation];
  /** Basic session observation is independent of hook installation or trust. */
  const willWatch = observation !== "unavailable";

  // The marker names the CLI, so switching harness mid-workflow mints a new one
  // rather than quietly telling the wrong tool's story.
  useEffect(() => {
    setMarker((current) => (current.cli === cli ? current : mintMarker(workflow, cli)));
  }, [cli, workflow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readSetup = useCallback(async (light = false) => {
    try {
      const status = await window.anthill.liveSetupStatus(folder ?? undefined, light);
      setSetup(status.harnesses.find((item) => item.id === cli));
    } catch {
      // Nothing to say about observation is not a reason to block the
      // handover; the step reports `unavailable` and the flow continues.
      setSetup(undefined);
    }
  }, [cli, folder]);

  useSetupPoll(() => readSetup(true), !installing, cli === "codex" && Boolean(setup?.hookInstalled) && setup?.codexHooks?.state !== "ready");

  useEffect(() => {
    void readSetup();
  }, [readSetup]);

  const result = useMemo<BootstrapResult | null>(() => {
    if (!validation.valid) return null;
    try {
      return buildBootstrapPrompt(workflow, marker, { reportViaCli });
    } catch (problem) {
      if (problem instanceof WorkflowCompileError) return null;
      throw problem;
    }
  }, [workflow, validation.valid, marker, reportViaCli]);

  const files = result?.files ?? [];
  /** Nothing to place means nothing to ask about: no first step, not an empty one. */
  const hasAgents = files.length > 0;
  const firstStep: Step = hasAgents ? 1 : 2;
  const [step, setStep] = useState<Step>(() => (hasAgents && !runRoot(workflow) ? 1 : 2));

  const [reviewSetup, setReviewSetup] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string>();
  useEffect(() => {
    if (step === 2 && setup?.observationDeclined && !reviewSetup) setStep(3);
  }, [step, setup?.observationDeclined, reviewSetup]);

  const continueBasic = async () => {
    if (cli !== "pi" && setup && !setup.hookInstalled) {
      try {
        await window.anthill.liveSetupDecline(cli);
        setSetup((current) => current ? { ...current, observationDeclined: true } : current);
      } catch {
        setPreferenceError("Could not save your preference. You can continue with basic progress; Anthill may ask again next time.");
      }
    }
    setStep(3);
  };

  /**
   * Waiting for the session, once the prompt has gone.
   *
   * The modal stays open on a successful copy — closing would read as "handed
   * over, done" while the session has not started — and only a snapshot that
   * names this run closes it. An unrelated session must not, and an ambiguous
   * match must not: Anthill does not pick one and claim it is yours.
   */
  useEffect(() => {
    if (!copiedPrompt || !willWatch) return;
    let live = true;
    let off: (() => void) | undefined;
    try {
      off = window.anthill.onLiveSnapshot((snapshot) => {
        if (!live) return;
        const run = snapshot.runs.find((item) => item.anthillRunId === marker.runId);
        if (!run) return;
        if (run.state === "ambiguous_match") setDetection("ambiguous");
        else if (run.state === "detected_live") onClose();
      });
    } catch {
      // No channel to listen on. The panel keeps saying it is waiting, which
      // remains true.
    }
    return () => {
      live = false;
      off?.();
    };
  }, [copiedPrompt, willWatch, marker.runId, onClose]);

  const choose = useCallback(async () => {
    const picked = await window.anthill.chooseRunFolder();
    if (!picked) return;
    setFolder(picked);
    setFailure(null);
    setPlacement("pending");
    onRunRoot?.(picked);
    setStep(2);
  }, [onRunRoot]);

  const install = useCallback(async () => {
    setInstalling(true);
    try {
      const outcome = await window.anthill.liveSetupInstall(cli, folder ?? undefined);
      setInstalling(false);
      if (outcome.ok) {
        setInstallFailed(undefined);
        setSetup(outcome.status.harnesses.find((item) => item.id === cli));
      } else {
        setInstallFailed(outcome.error);
      }
    } catch (problem) {
      setInstalling(false);
      setInstallFailed(
        problem instanceof Error ? problem.message : "The hook entries could not be written.",
      );
    }
  }, [cli, folder]);

  /**
   * Files, then the run, then the clipboard.
   *
   * A failed write does not stop the copy: a half-written folder is worth
   * naming, and withholding the prompt over it would leave the author with
   * nothing at all. The receipt says which of the two happened.
   */
  const copy = useCallback(
    async (withFiles: boolean) => {
      if (!result) return;
      // The prompt is built for the shell once it is known; a copy before
      // the capability query answers would hand over the wrong one.
      if (reportViaCli === undefined) return;
      setError(null);
      try {
        if (withFiles && hasAgents && folder) {
          const response = await window.anthill.exportWorkflow({ files, root: folder });
          if (response.ok) {
            setPlacement("written");
            setFailure(null);
          } else if (!("cancelled" in response)) {
            setPlacement("failed");
            setFailure(response.error);
            setRolledBack(response.rolledBack !== false);
          }
        }

        // Registered before the text leaves: once it is on the clipboard,
        // Anthill has no further say in what happens to it.
        await window.anthill.liveObserve({
          anthillRunId: marker.runId,
          correlationNonce: marker.nonce,
          selectedCli: marker.cli,
          promptVersion: marker.promptVersion,
          bootstrapPromptHash: await hashPrompt(result.bootstrapPrompt),
          ...(workflow.id ? { workflowId: workflow.id } : {}),
          ...(workflow.name ? { workflowName: workflow.name } : {}),
          // The same list the prompt told the session to announce, so a step
          // reported back can be named rather than left as a block id.
          steps: workflowSteps(workflow),
        });
        await navigator.clipboard.writeText(result.bootstrapPrompt);
        setCopiedPrompt(true);
        setStep(3);
        onObserving?.();
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : "The prompt could not be copied.");
      }
    },
    [files, folder, hasAgents, marker, onObserving, result, reportViaCli, workflow.id, workflow.name],
  );

  /** Back to naming a folder. The copy, if there was one, is not undone. */
  const changeFolder = useCallback(() => {
    setFolder(null);
    setPlacement("none");
    setFailure(null);
    setStep(1);
  }, []);

  const lines = result ? result.bootstrapPrompt.split("\n").length : 0;
  const words = result ? result.bootstrapPrompt.trim().split(/\s+/).length : 0;

  /** How the handover receipt describes whatever step 2 ended as. */
  const liveReceipt =
    observation === "ready" || observation === "passive"
      ? { tone: "ok", text: "Live progress on" }
      : observation === "awaiting-session"
        ? { tone: "ok", text: "Detailed progress ready — start a new Codex session" }
        : observation === "unavailable"
          ? { tone: "flat", text: `No live progress — ${harnessProfile.displayName} was not found` }
          : { tone: "flat", text: "Basic progress on" };

  const title =
    step === 1
      ? "Set up the agent files"
      : step === 2
        ? "Enable Live Observation"
        : copiedPrompt
          ? `Paste it into ${harnessProfile.displayName}`
          : `Hand over to ${harnessProfile.displayName}`;

  const subtitle =
    step === 1
      ? "One thing to place before the session can use your agents."
      : step === 2
        ? "Optional. Skip it and the handover still works."
        : copiedPrompt
          ? "The session is yours now — Anthill only watches."
          : "Copy it, paste it, and Anthill takes it from there.";

  return (
    <div
      className="modal-scrim"
      role="presentation"
      // Only the backdrop dismisses. A click inside the panel must not bubble
      // out and close the screen it belongs to.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="handover" role="dialog" aria-modal="true" aria-label="Hand over the prompt">
        <header className="handover-top">
          <img
            className="handover-logo"
            src={interpreterLogo(cli)}
            alt=""
            width={28}
            height={28}
          />
          <div className="handover-titles">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <span className="spacer" />
          {/* Visible through the final waiting state, with step 3 done: the
              author can see the sequence ends. */}
          <div className="handover-steps" role="group" aria-label={`Step ${step} of 3`}>
            {([1, 2, 3] as Step[])
              .filter((item) => item >= firstStep)
              .map((item) => (
                <span
                  key={item}
                  className={`step-pill${
                    item === step && !copiedPrompt
                      ? " is-active"
                      : item < step || copiedPrompt
                        ? " is-done"
                        : ""
                  }`}
                >
                  {STEP_NAMES[item]}
                </span>
              ))}
          </div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </header>

        {!result ? (
          <div className="handover-body">
            <p className="empty">
              Fix the problems listed under Problems and the prompt appears here.
            </p>
          </div>
        ) : step === 1 ? (
          <>
            <div className="handover-body">
              <section className="handover-panel">
                <h2>Where will the session run?</h2>
                <p>
                  Anthill writes one file per agent into that folder, as{" "}
                  <code>{`${harnessProfile.agentDir ?? ".claude/agents"}/*.${agentFileExtension(harnessProfile)}`}</code>. Those files are what{" "}
                  {harnessProfile.displayName} delegates to when a step hands work to one of
                  your agents.
                </p>
                <p>
                  They cannot wait until the session starts. A harness fixes its list of
                  callable agents at start-up, so anything written later is invisible to it —
                  without these files a {files.length}-agent workflow runs as one agent doing
                  everything.
                </p>

                <div className="handover-folder is-unset">
                  <span className="label">Folder</span>
                  <span className="value">Not chosen yet</span>
                  <span className="spacer" />
                  <button type="button" onClick={() => void choose()}>
                    Choose folder…
                  </button>
                </div>

                <span className="field-label">Will be written</span>
                <ul className="handover-files">
                  {files.map((file) => (
                    <li key={file.path}>
                      <i aria-hidden="true" />
                      <code>{file.path}</code>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <footer className="handover-foot">
              <button type="button" className="primary" onClick={() => void choose()}>
                Choose folder…
              </button>
              {/* Named rather than refused: an author whose prompt is going to a
                  machine Anthill cannot see needs a way through, and the cost
                  of taking it belongs on the button, not in a dead end. */}
              <button type="button" onClick={() => void copy(false)} disabled={reportViaCli === undefined}>
                Copy without agent files
              </button>
              <span className="hint">Nothing is written until you pick a folder.</span>
            </footer>
          </>
        ) : step === 2 ? (
          <>
            <div className="handover-body">
              <ObservationStep
                label={harnessProfile.displayName}
                harness={setup}
                state={observation}
                {...(installFailed !== undefined ? { error: installFailed } : {})}
                busy={installing}
                onInstall={() => void install()}
              />
            </div>

            <footer className="handover-foot">
              <button
                type="button"
                className="primary"
                disabled={installing}
                onClick={face.install ? () => void install() : () => setStep(3)}
              >
                {face.primary}
              </button>
              {/* Never two buttons reading Continue: the secondary only offers
                  to skip where there is something to skip. */}
              {face.install ? (
                <button type="button" disabled={installing} onClick={() => void continueBasic()}>
                  Continue with basic progress
                </button>
              ) : hasAgents ? (
                <button type="button" onClick={() => setStep(1)}>
                  Back
                </button>
              ) : null}
              <span className="hint">
                {face.install
                  ? "Nothing is installed until you enable it."
                  : observation === "unavailable"
                    ? "There is nothing to install for a CLI Anthill cannot find."
                    : observation === "passive"
                      ? "Nothing to install — this tool has no hook mechanism."
                      : observation === "needs-trust" || observation === "disabled" || observation === "check-failed"
                        ? "Basic progress remains available while you finish connecting."
                        : "Already set up — nothing is written again."}
              </span>
            </footer>
          </>
        ) : (
          <>
            <div className="handover-body">
              {hasAgents && folder ? (
                <section className={`handover-receipt is-${placement}`}>
                  <span className="dot" aria-hidden="true" />
                  <div>
                    <p className="handover-receipt-head">
                      {placement === "written"
                        ? `${files.length} agent ${files.length === 1 ? "file" : "files"} written`
                        : placement === "failed"
                          ? rolledBack
                            ? "No agent files were written"
                            : "The agent files were left part-written"
                          : `${files.length} agent ${files.length === 1 ? "file" : "files"} will be written here`}
                    </p>
                    <code className="handover-path">{folder}</code>
                    <p className="hint">
                      {placement === "failed"
                        ? failure
                        : `${harnessProfile.displayName} reads them when a step hands work to one of your agents.`}
                    </p>
                  </div>
                  <span className="spacer" />
                  <button type="button" onClick={changeFolder}>
                    Change…
                  </button>
                </section>
              ) : null}

              {/* The second receipt: what state observation was left in, in its
                  own tone, so the author can see what they are handing over in. */}
              <section className={`state-panel tone-${liveReceipt.tone} is-receipt`}>
                <div className="state-panel-head">
                  <span className="state-dot" aria-hidden="true" />
                  <span className="state-title">{liveReceipt.text}</span>
                  <button type="button" className="state-chip" onClick={() => { setReviewSetup(true); setStep(2); }}>
                    Change…
                  </button>
                </div>
              </section>

              {preferenceError ? <p role="status">{preferenceError}</p> : null}

              {copiedPrompt && willWatch ? (
                <section
                  className={`state-panel tone-${detection === "ambiguous" ? "unsure" : "flat"}`}
                  role="status"
                >
                  <div className="state-panel-head">
                    <span
                      className={`state-dot${detection === "ambiguous" ? "" : " live-pulse"}`}
                      aria-hidden="true"
                    />
                    <span className="state-title">
                      {detection === "ambiguous"
                        ? "More than one session could be this workflow"
                        : `Waiting for the session in ${harnessProfile.displayName}`}
                    </span>
                    {detection === "ambiguous" ? (
                      <span className="state-chip">Not sure yet</span>
                    ) : null}
                  </div>
                  <p className="state-note">
                    {detection === "ambiguous"
                      ? "Anthill will not pick one and claim it is yours. Close the others, or open the one you started and it will match on the run marker."
                      : `Copying does not start anything. Paste the prompt into ${harnessProfile.displayName} and run it — when Anthill sees the run marker in what it writes, this closes and the workflow goes live.`}
                  </p>
                </section>
              ) : null}

              <section className="handover-panel">
                <h2>How this works</h2>
                <ol className="handover-moves">
                  <li className={copiedPrompt ? "is-done" : undefined}>
                    <i aria-hidden="true">1</i>
                    <span>
                      {copiedPrompt
                        ? `The prompt is on your clipboard — the whole compiled workflow, ${words.toLocaleString()} words.`
                        : `Copy the prompt — the whole compiled workflow, ${words.toLocaleString()} words.`}
                    </span>
                  </li>
                  <li>
                    <i aria-hidden="true">2</i>
                    <span>
                      Paste it into {harnessProfile.displayName} and start the session yourself.{" "}
                      <strong>Anthill does not run it.</strong>
                    </span>
                  </li>
                  <li>
                    <i aria-hidden="true">3</i>
                    <span>
                      Anthill recognises that session from the marker and shows the workflow
                      running: the live step, the rework loops, and what it cannot tell you.
                    </span>
                  </li>
                </ol>

                <div className="run-marker">
                  <span className="key">Anthill run</span>
                  <code>{marker.runId}</code>
                  <span className="key">nonce</span>
                  <code>{marker.nonce}</code>
                </div>
                <p className="hint">No secrets, tokens, or file paths.</p>

                <button
                  type="button"
                  className="handover-inspect"
                  aria-expanded={previewOpen}
                  onClick={() => setPreviewOpen((open) => !open)}
                >
                  <i aria-hidden="true">{previewOpen ? "⌄" : "›"}</i> Inspect the prompt ·{" "}
                  {lines.toLocaleString()} lines
                </button>
                {previewOpen ? (
                  <pre className="handover-preview">{result.bootstrapPrompt}</pre>
                ) : null}
              </section>

              {/* Said before the prompt leaves, not after the run looks wrong.
                  Amber rather than red: the workflow is fine and will run — it
                  is the per-agent models that will not reach this CLI. */}
              {codexReadsAgents === false && result.files.length > 0 ? (
                <p className="hint warn">
                  The Codex installed here does not read <code>.codex/agents</code>, so these
                  agent files will be ignored and every step will run on the model the session
                  starts with. Update Codex to have the models you chose applied.
                </p>
              ) : null}

              {result.warnings.map((warning) => (
                <p key={warning} className="hint warn">
                  {warning}
                </p>
              ))}
              {error ? <p className="hint warn">{error}</p> : null}
            </div>

            <footer className="handover-foot">
              <button
                type="button"
                className="primary"
                disabled={reportViaCli === undefined}
                onClick={() => void copy(true)}
              >
                {placement === "failed"
                  ? "Try that folder again"
                  : copiedPrompt
                    ? "Copy again"
                    : "Copy prompt"}
              </button>
              <button type="button" onClick={() => setStep(2)}>
                Back
              </button>
              <span className="hint">
                {reportViaCli === undefined
                  ? "Waiting to learn how this shell runs before the prompt can be copied."
                  : !hasAgents
                    ? "No agent files: this workflow is one agent."
                    : placement === "failed"
                      ? "The prompt is already copied."
                      : !folder
                        ? "Copied without the agent files — that session runs as one agent."
                        : copiedPrompt
                          ? "The session is yours now — Anthill only watches."
                          : "Files land first, then the clipboard."}
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
