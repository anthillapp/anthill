/**
 * Connecting a coding tool, without leaving the agent.
 *
 * A sheet anchored to the editor pane rather than to the window. That
 * containment is the design: the unsaved profile stays visible behind it, so
 * the question this step really raises — "have I just lost what I typed?" — is
 * answered by what the author can see rather than by a sentence promising it.
 * A centred modal or a trip back to the library would both break that.
 *
 * What it reports is which step it is on, never what it ran. No commands, no
 * paths, no config files: those are diagnostics, and a setup screen that shows
 * them has made the author responsible for reading them.
 *
 * What it can do stays narrow. It looks for the CLI, asks that CLI whether
 * anyone is signed in, and opens a terminal on the CLI's own login command. It
 * signs nobody in — the browser flow and the account are the author's, and
 * Anthill never sees either — and it installs nothing, starts no session, runs
 * no workflow, and touches no Live Observation hook.
 */

import { useEffect, useRef } from "react";

import { harnessProfile, interpreterDefinition } from "@anthill/workflow";
import type { HarnessTarget } from "@anthill/workflow-schema";

import { interpreterLogo } from "../workflow/interpreter-logos.js";
import type { HarnessConnection } from "./useHarnessConnections.js";

/** One line of the sheet's account of where it got to. */
type Step = { label: string; state: "done" | "now" | "bad" | "todo"; word?: string };

type Script = {
  title: string;
  body: string;
  steps: Step[];
  primary: string;
  /** Whether pressing the primary asks the machine again or simply leaves. */
  primaryKind: "connect" | "recheck" | "done";
};

const FOUND = "Found on this machine";
const SIGNED = "Signed in";
const LINKED = "Connected to Anthill";

/**
 * What the sheet says, for the state the tool is actually in.
 *
 * Kept as data so every ending is visible in one place — including the ones
 * that are not success, which is most of them and the reason this screen
 * exists.
 */
export function connectScript(
  connection: HarnessConnection,
  target: HarnessTarget,
  context: ConnectContext = "agent",
): Script {
  const harness = harnessProfile(target);
  const short = harness.displayName;

  switch (connection.status) {
    case "on":
      return {
        title: `${short} is connected`,
        body:
          context === "settings"
            ? harness.supportsPerAgentModel
              ? `Agents can now be given a ${short} model, and the Models page lists what it offers.`
              : `${short} has no per-agent model, so a workflow targeting it uses the model chosen in the session.`
            : harness.supportsPerAgentModel
              ? `You can now choose the model this agent uses when a workflow targets ${short}.`
              : `${short} has no per-agent model, so a workflow targeting it uses the model chosen in the session.`,
        steps: [
          { label: FOUND, state: "done", word: "Done" },
          {
            label: SIGNED,
            // The step is passed either way — a tool is not held back on a
            // question that could not be asked — but a CLI that would not
            // answer gets "Not reported" rather than a "Done" it never gave.
            state: "done",
            word: connection.info?.signedIn === undefined ? "Not reported" : "Done",
          },
          { label: LINKED, state: "done", word: "Done" },
        ],
        primary:
          context === "settings"
            ? "Done"
            : harness.supportsPerAgentModel
              ? "Choose the model"
              : "Back to the agent",
        primaryKind: "done",
      };

    case "not-installed":
      return {
        title: `${short} was not found`,
        body: `Anthill looked for ${short} on this machine and did not find it. Install it, then check again – nothing here is lost.`,
        steps: [
          { label: FOUND, state: "bad", word: "Not found" },
          { label: SIGNED, state: "todo" },
          { label: LINKED, state: "todo" },
        ],
        primary: "Check again",
        primaryKind: "recheck",
      };

    case "signed-out":
      return {
        title: `Sign in to ${short}`,
        body: `${short} is installed but signed out. Sign in from its own window, then check again.`,
        steps: [
          { label: FOUND, state: "done", word: "Done" },
          { label: SIGNED, state: "bad", word: "Signed out" },
          { label: LINKED, state: "todo" },
        ],
        primary: "Check again",
        primaryKind: "recheck",
      };

    case "failed":
      return {
        title: "Connecting did not finish",
        body: `Anthill stopped before connecting ${short}. This agent and your workflows are unchanged.`,
        steps: [
          { label: FOUND, state: "done", word: "Done" },
          { label: SIGNED, state: "done", word: "Done" },
          { label: LINKED, state: "bad", word: "Failed" },
        ],
        primary: "Try again",
        primaryKind: "recheck",
      };

    case "checking":
      return {
        title: `Connecting ${short}`,
        body: `Anthill checks that ${short} is on this machine and signed in. It reads nothing from your project and starts nothing.`,
        steps: [
          { label: FOUND, state: "now", word: "Checking" },
          { label: SIGNED, state: "todo" },
          { label: LINKED, state: "todo" },
        ],
        primary: "Checking…",
        primaryKind: "connect",
      };

    default:
      return {
        title: `Connect ${short}`,
        body: `Anthill checks that ${short} is on this machine and signed in. It reads nothing from your project and starts nothing.`,
        steps: [
          { label: FOUND, state: "todo" },
          { label: SIGNED, state: "todo" },
          { label: LINKED, state: "todo" },
        ],
        primary: `Connect ${short}`,
        primaryKind: "connect",
      };
  }
}

/**
 * Where the sheet was opened from. The agent editor is the original home and
 * the default; Settings opens the same sheet (ANT-135), where there is no
 * agent behind it and "your unsaved changes to this agent" would be a promise
 * about something that is not there.
 */
export type ConnectContext = "agent" | "settings";

export type ConnectHarnessProps = {
  target: HarnessTarget;
  context?: ConnectContext;
  connection: HarnessConnection;
  /** Ask the machine again about this tool. */
  onRecheck: () => void;
  onClose: () => void;
};

export function ConnectHarness({ target, context = "agent", connection, onRecheck, onClose }: ConnectHarnessProps) {
  const harness = harnessProfile(target);
  const definition = interpreterDefinition(target);
  const script = connectScript(connection, target, context);
  const busy = connection.status === "checking";

  /**
   * Focus moves into the sheet as it opens.
   *
   * The sheet claims `aria-modal`, so leaving focus behind the scrim would let
   * the keyboard walk content the sheet has just declared inert.
   */
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
  }, []);

  /**
   * Escape dismisses. "Cancelled" is one of this flow's real states, and a
   * click on the backdrop is not how anyone dismisses a dialog from a
   * keyboard.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="connect-scrim" onMouseDown={(event) => {
      // Only the backdrop itself, never a mousedown that began inside the
      // sheet and happened to end out here.
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className="connect-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${harness.displayName}`}
      >
        <div className="connect-top">
          <img className="tool-logo is-mark" src={interpreterLogo(target)} alt="" />
          <span className="kicker">Connect · {harness.displayName}</span>
        </div>

        <h3 className="connect-title">{script.title}</h3>
        <p className="connect-body">{script.body}</p>

        <div className="connect-steps">
          {script.steps.map((step) => (
            <div className={`connect-step is-${step.state}`} key={step.label}>
              {/* The dot is decoration; the word beside it carries the state,
                  which is why reduced motion can drop the pulse and lose
                  nothing. */}
              <i aria-hidden="true" />
              <span>{step.label}</span>
              {step.word ? <em>{step.word}</em> : null}
            </div>
          ))}
        </div>

        {/* The sentence the whole containment exists to make true. */}
        <p className="connect-note">
          {context === "settings"
            ? "Connecting changes nothing in your workflows or agents – you come back to this page when setup finishes."
            : "Your unsaved changes to this agent are kept – you come back to this section when setup finishes."}
        </p>

        {connection.status === "signed-out" ? (
          <p className="connect-note">
            Signing in happens in {harness.displayName}&rsquo;s own window. Anthill never sees
            it: the browser flow and the account are yours.
          </p>
        ) : null}

        {/* The honest reading of a CLI that would not answer the sign-in
            question: the tool counts as connected, but the author is told the
            check was not made — so a signed-out tool is not discovered only
            as a failed run. */}
        {connection.status === "on" && connection.info?.signedIn === undefined ? (
          <p className="connect-note">
            Anthill cannot check {harness.displayName}&rsquo;s sign-in, so it is shown as
            connected. If a workflow fails to start, check {harness.displayName} is
            signed in from its own window.
          </p>
        ) : null}

        <div className="connect-actions">
          <button
            ref={primary}
            type="button"
            className={`tool-connect${busy ? " is-busy" : ""}`}
            disabled={busy}
            onClick={() => {
              if (script.primaryKind === "done") onClose();
              else onRecheck();
            }}
          >
            {script.primary}
          </button>

          {/* Only where there is something for it to do. Anthill cannot sign
              anyone in, so it hands over the CLI's own login rather than
              pretending to. */}
          {connection.status === "signed-out" ? (
            <button
              type="button"
              className="tool-review"
              onClick={() => void window.anthill.signInToInterpreter(definition.id)}
            >
              Open {harness.displayName} to sign in
            </button>
          ) : null}

          {/* In Settings a connected tool's primary is already "Done"; a
              Close beside it would be the same button twice. */}
          {context === "settings" && script.primaryKind === "done" ? null : (
            <button type="button" onClick={onClose}>
              {connection.status === "on" ? "Close" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
