/**
 * Prompt-to-Workflow: describe the work, get a workflow to edit.
 *
 * The alternative to drawing a workflow block by block. The author pastes whatever
 * they have — a paragraph, a rambling brief, a multi-stage orchestration
 * document — and a coding CLI they already have installed reads it and proposes
 * a shape.
 *
 * Three steps rather than one long sheet. Asking for the prompt, the tool and
 * the run on one screen made the tool choice look like a setting to skip past,
 * and buried the thing that needs the most attention — the prompt — above two
 * blocks of explanation. One question per screen: write it, choose who reads
 * it, watch it being read.
 *
 * Three things this flow has to make true, because none of them is obvious:
 *
 * - Anthill is not calling a model. It is running a program on this machine
 *   that the author installed and signed in to themselves. There is no API key
 *   to enter and nothing to configure, and the screen says so.
 * - The CLI is reading, not working. The exact command is on screen, with what
 *   it can and cannot do, before anything runs.
 * - Nothing is created until the author says so.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  applyAnswers,
  buildDraftInstruction,
  interpreterDefinition,
  isSignedOutFailure,
  needsClarification,
  parseDraftResponse,
  reviewDraft,
  type DraftAnswers,
  type DraftReview,
  type InterpreterId,
  type WorkflowDraft,
} from "@anthill/workflow";
import { withLayout } from "@anthill/builder";

import type { InterpreterInfo, PromptDraftStage } from "../../shared/ipc.js";
import { interpreterLogo } from "./interpreter-logos.js";
import { DraftClarify } from "./DraftClarify.js";
import {
  PREVIEW_EDGES,
  PREVIEW_NODES,
  PREVIEW_SIZE,
  previewPath,
} from "./draft-preview.js";

export type PromptToWorkflowSheetProps = {
  /**
   * The workflow this screen was opened over, when there is one. Every screen
   * with a workflow open names it beside the screen's own name, so the bar
   * always says both what you are looking at and what it is about.
   */
  workflowName?: string;
  onAccept: (workflow: Workflow) => void;
  onCancel: () => void;
};

/** Which CLI to reach for by default. A UI preference, not project data. */
const SETTING_KEY = "anthill.promptInterpreter";

function readSetting(): InterpreterId | undefined {
  try {
    const value = window.localStorage.getItem(SETTING_KEY);
    return value === "claude-code" || value === "codex" || value === "pi" ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeSetting(id: InterpreterId): void {
  try {
    window.localStorage.setItem(SETTING_KEY, id);
  } catch {
    // A preference that cannot be remembered is not worth failing over.
  }
}

/**
 * The stages of one drafting run, in the order they happen.
 *
 * Named after what is actually being done, and never entered early. The two the
 * CLI owns are reported by main; the two after it are Anthill's own work on the
 * reply. Nothing here reflects the interpreter's thinking — that is its
 * working, and relaying it would both leak reasoning and suggest Anthill had
 * recognised parts of a workflow before any valid draft existed.
 */
/**
 * The stage list, and which lines are evidence.
 *
 * `preparing`, `validating` and `assembling` are Anthill's own work.
 * `analyzing` is the wait — the locked-down CLIs stream nothing mid-run, so
 * it is a product state, and the hint below the list says so in words.
 * `replying` is the one stage the interpreter itself evidences: its first
 * byte of output, counted and never read.
 */
const STAGES = [
  { id: "preparing", label: "Preparing the local interpreter" },
  { id: "analyzing", label: "Analyzing your prompt" },
  { id: "replying", label: "The draft is arriving" },
  { id: "validating", label: "Validating the draft" },
  { id: "assembling", label: "Preparing the editable workflow" },
] as const;

type StageId = (typeof STAGES)[number]["id"];

/** The three steps named in the sub-bar. `running` is the third's own state. */
const WIZARD = [
  { id: "compose", no: 1, label: "Prompt" },
  { id: "interpreter", no: 2, label: "Interpreter" },
  { id: "running", no: 3, label: "Draft" },
] as const;

type Phase =
  | { kind: "compose" }
  | { kind: "interpreter" }
  | { kind: "running"; stage: StageId }
  | {
      kind: "failed";
      error: string;
      command: string;
      reply?: string;
      /** Which CLI failed, so the panel can name that CLI's own way back in. */
      interpreterId: InterpreterId;
    }
  | {
      kind: "clarify";
      review: DraftReview;
      draft: WorkflowDraft;
      command: string;
      interpreterLabel: string;
    };

export function PromptToWorkflowSheet({ onAccept, onCancel, workflowName }: PromptToWorkflowSheetProps) {
  const [prompt, setPrompt] = useState("");
  const [interpreters, setInterpreters] = useState<InterpreterInfo[] | null>(null);
  const [chosen, setChosen] = useState<InterpreterId | undefined>(readSetting);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });

  /**
   * Ask what is installed, and whether it is signed in.
   *
   * Asked again on demand because the answer changes while Anthill is not
   * looking: signing in happens in a terminal and a browser, and a picker that
   * kept saying "not signed in" afterwards would be telling the author their
   * own work did not count, and asking them to restart the app to prove it.
   */
  const [looking, setLooking] = useState(false);
  const look = useCallback(async () => {
    setLooking(true);
    try {
      const found = await window.anthill.detectInterpreters();
      setInterpreters(found);
      // Only pick for the author when they have expressed no preference: a
      // chosen interpreter that is missing must say so, not be swapped out.
      setChosen((current) => current ?? found.find((item) => item.available)?.id);
    } finally {
      setLooking(false);
    }
  }, []);

  useEffect(() => {
    void look();
  }, [look]);

  /**
   * Coming back to Anthill is the signal that something may have changed.
   *
   * Signing in takes the author out of this window and into a terminal and a
   * browser; returning is exactly the moment the old answer is most likely to
   * be stale, and re-asking costs one short process.
   */
  useEffect(() => {
    const onFocus = () => void look();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [look]);

  const installed = useMemo(
    () => (interpreters ?? []).filter((item) => item.available),
    [interpreters],
  );
  const selected = useMemo(
    () => interpreters?.find((item) => item.id === chosen),
    [interpreters, chosen],
  );

  const choose = useCallback((id: InterpreterId) => {
    setChosen(id);
    writeSetting(id);
  }, []);

  // Stage reports arrive on a push channel while the run is in flight.
  useEffect(() => {
    return window.anthill.onPromptDraftStage((stage: PromptDraftStage) => {
      setPhase((current) => (current.kind === "running" ? { ...current, stage } : current));
    });
  }, []);

  /** Turn a validated draft into the workflow the author will edit. */
  const open = useCallback(
    (draft: WorkflowDraft, review: DraftReview) => {
      onAccept(withLayout(review.workflow));
      void draft;
    },
    [onAccept],
  );

  const generate = useCallback(async () => {
    if (!chosen || prompt.trim().length === 0) return;
    setPhase({ kind: "running", stage: "preparing" });

    const response = await window.anthill.draftFromPrompt({
      interpreterId: chosen,
      instruction: buildDraftInstruction(prompt),
    });

    if (!response.ok) {
      // Cancelling is the author's decision, not a failure to report at them.
      setPhase(
        response.cancelled
          ? { kind: "interpreter" }
          : {
              kind: "failed",
              error: response.error,
              command: response.command,
              interpreterId: chosen,
            },
      );
      return;
    }

    setPhase({ kind: "running", stage: "validating" });
    const parsed = parseDraftResponse(response.reply);
    if (!parsed.ok) {
      // The prompt is untouched in state, so the retry costs the author nothing.
      setPhase({
        kind: "failed",
        error: parsed.error,
        command: response.command,
        reply: parsed.raw,
        interpreterId: chosen,
      });
      return;
    }

    setPhase({ kind: "running", stage: "assembling" });
    const review = reviewDraft(parsed.draft, parsed.warnings, {
      prompt,
      interpreter: chosen,
      command: response.command,
    });

    // A draft with nothing open must not make the author confirm a screen they
    // have no input on: it opens straight onto the canvas.
    if (!needsClarification(parsed.draft)) {
      open(parsed.draft, review);
      return;
    }

    setPhase({
      kind: "clarify",
      review,
      draft: parsed.draft,
      command: response.command,
      interpreterLabel: selected?.label ?? "The interpreter",
    });
  }, [chosen, prompt, selected, open]);

  const cancel = useCallback(() => {
    void window.anthill.cancelPromptDraft();
  }, []);

  /** Answers are folded into the draft, then the workflow is built from it. */
  const acceptAnswers = useCallback(
    (answers: DraftAnswers) => {
      if (phase.kind !== "clarify" || !chosen) return;
      const { draft } = applyAnswers(phase.draft, answers);
      const review = reviewDraft(draft, phase.review.warnings, {
        prompt,
        interpreter: chosen,
        command: phase.command,
      });
      open(draft, review);
    },
    [phase, chosen, prompt, open],
  );

  const step: (typeof WIZARD)[number]["id"] =
    phase.kind === "compose" || phase.kind === "failed"
      ? "compose"
      : phase.kind === "interpreter"
        ? "interpreter"
        : "running";

  const back = useCallback(() => {
    if (phase.kind === "running") {
      cancel();
      setPhase({ kind: "interpreter" });
      return;
    }
    if (phase.kind === "interpreter") {
      setPhase({ kind: "compose" });
      return;
    }
    onCancel();
  }, [phase, cancel, onCancel]);

  if (phase.kind === "clarify") {
    return (
      <DraftClarify
        draft={phase.draft}
        interpreterLabel={phase.interpreterLabel}
        onBack={() => setPhase({ kind: "interpreter" })}
        onOpen={acceptAnswers}
      />
    );
  }

  return (
    <div className="app">
      <div className="subbar">
        <button className="icon-button" onClick={back} title="Back">
          ←
        </button>
        <span className="brand">Workflow from a prompt</span>
        {workflowName ? <span className="screen-subject">{workflowName}</span> : null}
        <span className="spacer" />
        <div className="wizard" aria-label={`Step ${WIZARD.findIndex((w) => w.id === step) + 1} of 3`}>
          {WIZARD.map((item, index) => {
            const at = WIZARD.findIndex((w) => w.id === step);
            const state = index < at ? "done" : index === at ? "now" : "next";
            return (
              <span key={item.id} className={`wizard-step ${state}`}>
                <i>{item.no}</i>
                {item.label}
              </span>
            );
          })}
        </div>
      </div>

      <div className="sheet-body prompt-flow">
        <div className="prompt-column">
          {step === "compose" ? (
            <Compose
              prompt={prompt}
              onPrompt={setPrompt}
              installed={installed.length}
              failure={phase.kind === "failed" ? phase : undefined}
              onContinue={() => setPhase({ kind: "interpreter" })}
            />
          ) : null}

          {step === "interpreter" ? (
            <ChooseInterpreter
              looking={looking}
              onLookAgain={() => void look()}
              prompt={prompt}
              interpreters={interpreters}
              selected={selected}
              onChoose={choose}
              onEditPrompt={() => setPhase({ kind: "compose" })}
              onGenerate={generate}
            />
          ) : null}

          {phase.kind === "running" ? (
            <Running
              stage={phase.stage}
              interpreterLabel={selected?.label ?? "The interpreter"}
              onCancel={cancel}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 · Prompt                                                     */
/* ------------------------------------------------------------------ */

/**
 * What to say when the CLI is simply not signed in.
 *
 * Anthill does not sign anyone in, and should not: the flow needs the author's
 * own browser and account, and handling their credentials is not this app's
 * business. What it can do is stop giving advice that could never work —
 * rewording a prompt has never renewed a session — and hand over the exact
 * command, so the way out is one copy and one paste rather than a search.
 */
function SignedOut({
  interpreterId,
  lede,
  looking,
  onLookAgain,
}: {
  interpreterId: InterpreterId;
  lede: string;
  /** Absent where there is nothing to re-check against, as on a past failure. */
  looking?: boolean;
  onLookAgain?: () => void;
}) {
  const item = interpreterDefinition(interpreterId);
  const [opened, setOpened] = useState<"idle" | "opened" | "failed">("idle");
  const [why, setWhy] = useState<string | undefined>();

  return (
    <div className="signed-out">
      <p className="hint">{lede}</p>
      <div className="signed-out-row">
        <button
          type="button"
          className="primary"
          onClick={() => {
            void window.anthill
              .signInToInterpreter(item.id)
              .then((outcome) => {
                setOpened(outcome.ok ? "opened" : "failed");
                setWhy(outcome.error);
              })
              .catch((error: Error) => {
                setOpened("failed");
                setWhy(error.message);
              });
          }}
        >
          Sign in to {item.label}
        </button>
        <code>{item.signIn}</code>
        {onLookAgain ? (
          <button type="button" disabled={looking} onClick={onLookAgain}>
            {looking ? "Checking…" : "Check again"}
          </button>
        ) : null}
      </div>
      {opened === "opened" ? (
        <p className="hint">
          Your terminal is running <code>{item.signIn}</code>. Finish signing in
          there and come back to this window — Anthill checks again when it has
          your attention, and starts a fresh {item.command} for every draft, so
          there is nothing to restart.
        </p>
      ) : opened === "failed" ? (
        // Says what went wrong, not only that something did: a button that
        // reports a bare failure leaves nothing to act on.
        <p className="hint warn">
          The terminal could not be opened{why ? `: ${why}` : ""}. Run{" "}
          <code>{item.signIn}</code> yourself, then come back.
        </p>
      ) : (
        <p className="hint">
          This opens your terminal and runs that command. Anthill never sees your
          sign-in: the browser flow and the account are yours.
        </p>
      )}
    </div>
  );
}

function Compose({
  prompt,
  onPrompt,
  installed,
  failure,
  onContinue,
}: {
  prompt: string;
  onPrompt: (value: string) => void;
  installed: number;
  failure?: { error: string; command: string; reply?: string; interpreterId: InterpreterId };
  onContinue: () => void;
}) {
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  const empty = prompt.trim().length === 0;

  return (
    <>
      <div>
        <h1>Describe the work</h1>
        <p className="lede">
          Paste anything — a paragraph, a brief, a whole process document.
          Nothing is created until you have seen what comes back.
        </p>
      </div>

      {/* The textarea is the card, not a box inside one. */}
      <div className="prompt-card">
        <textarea
          rows={14}
          value={prompt}
          autoFocus
          placeholder="e.g. Build a login page with email and password, review it before merging, and loop back on failing tests until they pass."
          onChange={(event) => onPrompt(event.target.value)}
        />
        <div className="prompt-card-foot">
          <span>Kept with the workflow, so you can see later what you actually asked for.</span>
          <span className="spacer" />
          <span className="count">{words} {words === 1 ? "word" : "words"}</span>
        </div>
      </div>

      {failure ? (
        <div className="slab">
          <h2>That did not work</h2>
          <p className="note">{failure.error}</p>
          {isSignedOutFailure(failure.error) ? (
            <SignedOut
              interpreterId={failure.interpreterId}
              lede={`Your prompt is untouched. ${
                interpreterDefinition(failure.interpreterId).label
              } is not signed in — this is not about the prompt, and rewording it will not help.`}
            />
          ) : (
            <p className="hint">
              Your prompt is untouched. Try again, or reword it — asking for fewer,
              clearer stages usually helps.
            </p>
          )}
          <p className="hint">
            Command: <code>{failure.command}</code>
          </p>
          {failure.reply ? (
            <>
              <span className="field-label">What it said</span>
              <pre className="reply-dump">{failure.reply.slice(0, 4000)}</pre>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        <button className="primary" disabled={empty} onClick={onContinue}>
          Continue
        </button>
        <span className="hint">
          {empty
            ? "Write something first."
            : installed === 1
              ? "Next: confirm which installed CLI reads it."
              : "Next: pick which installed CLI reads it."}
        </span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 · Interpreter                                                */
/* ------------------------------------------------------------------ */

function ChooseInterpreter({
  prompt,
  interpreters,
  selected,
  looking,
  onChoose,
  onEditPrompt,
  onGenerate,
  onLookAgain,
}: {
  prompt: string;
  interpreters: InterpreterInfo[] | null;
  selected: InterpreterInfo | undefined;
  looking: boolean;
  onChoose: (id: InterpreterId) => void;
  onEditPrompt: () => void;
  onGenerate: () => void;
  onLookAgain: () => void;
}) {
  const installed = (interpreters ?? []).filter((item) => item.available);
  const only = installed.length === 1 ? installed[0] : undefined;

  const heading =
    interpreters === null
      ? "Looking for installed tools…"
      : installed.length === 0
        ? "No coding CLI found"
        : only
          ? "Ready to read it"
          : "Which tool should read it?";

  const lede =
    interpreters === null
      ? "Checking what is on your PATH."
      : installed.length === 0
        ? "Neither Claude Code nor the Codex CLI was found on your PATH. Install one of them and sign in with it, then come back — or go back and build the workflow yourself, which needs no interpreter at all."
        : only
          ? `${only.label} is the only coding CLI installed, so it will read your prompt. Whatever it proposes, it only proposes a workflow — it does not do the work.`
          : "Both of these are installed on this machine. Whichever you pick only proposes a workflow — it does not do the work.";

  return (
    <>
      <div>
        <h1>{heading}</h1>
        <p className="lede">{lede}</p>
      </div>

      {/* Getting back to the prompt is on the screen three ways: here, the
          button below, and the arrow in the sub-bar. */}
      <button className="prompt-recap" onClick={onEditPrompt}>
        <span className="kicker">Your prompt</span>
        <span className="recap-text">{prompt}</span>
        <span className="recap-edit">Edit</span>
      </button>

      {installed.length > 0 ? (
        <div className={only ? "interpreter-grid single" : "interpreter-grid"}>
          {installed.map((item) => {
            const active = selected?.id === item.id;
            return (
              <button
                key={item.id}
                // One installed tool is not a choice, so it is not drawn as one.
                className={`interpreter-card${active && !only ? " active" : ""}${only ? " fixed" : ""}`}
                onClick={only ? undefined : () => onChoose(item.id)}
              >
                <span className="interpreter-head">
                  <img className="interpreter-logo" src={interpreterLogo(item.id)} alt="" />
                  <span className="interpreter-name">
                    {item.label}
                    <span className="interpreter-version">
                      {item.version ? `${item.version} · installed` : "installed"}
                    </span>
                  </span>
                  <span className="spacer" />
                  {only ? null : <i className={`radio${active ? " on" : ""}`} />}
                </span>
                <span className="interpreter-why">{item.boundary}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {interpreters !== null && installed.length === 0 ? (
        <div className="slab">
          <span className="field-label">Not found</span>
          <ul className="plain">
            {interpreters.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong> — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Asked before the run, not discovered after it: an expired session is
          the one failure that lets a draft look fine for a minute and then
          fail for a reason the prompt had nothing to do with. */}
      {selected?.available && selected.signedIn === false ? (
        <div className="slab">
          <h2>{selected.label} is not signed in</h2>
          <SignedOut
            interpreterId={selected.id}
            lede={`${selected.label} is installed, but nobody is signed in — a draft would run for a minute and then fail on that.`}
            looking={looking}
            onLookAgain={onLookAgain}
          />
        </div>
      ) : null}

      {selected?.available ? (
        <div className="slab">
          <span className="field-label">What Anthill will run</span>
          <pre className="command-line">{selected.command}</pre>
          <p className="hint">
            It reads the prompt and answers. It does not carry out the work, and
            it is not given access to your project — Anthill runs it on this
            machine with your own sign-in, so there is no API key to enter.
          </p>
        </div>
      ) : null}

      <div className="row">
        <button className="primary" disabled={!selected?.available} onClick={onGenerate}>
          Generate a draft
        </button>
        <button onClick={onEditPrompt}>Back to the prompt</button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3 · Drafting                                                   */
/* ------------------------------------------------------------------ */

/**
 * The wait, shown rather than described.
 *
 * A list of four stage names read as a hung window. The graph draws itself in
 * the canvas's own vocabulary — the dotted grid, a Start pill, blocks with
 * their category rules, a next edge, a rework return, a question path — so the
 * minute of waiting previews the thing being built. It is a loop, not a
 * progress bar: it says "working", and the stage list below says how far.
 *
 * Under `prefers-reduced-motion` every animation stops and the graph is simply
 * drawn. Each stage is named in text either way, so nothing depends on movement.
 */
function Running({
  stage,
  interpreterLabel,
  onCancel,
}: {
  stage: StageId;
  interpreterLabel: string;
  onCancel: () => void;
}) {
  const at = STAGES.findIndex((item) => item.id === stage);

  return (
    <>
      <div className="drafting-card">
        <span className="kicker">{interpreterLabel} is reading your prompt</span>
        <h2 aria-live="polite">{STAGES[Math.max(at, 0)].label}</h2>

        <div className="drafting-graph" aria-hidden="true">
          {/*
            One coordinate system, on purpose. Blocks used to be HTML elements
            placed in CSS pixels while edges were hand-typed path data, and
            keeping the two in agreement was arithmetic nobody re-did when the
            layout moved — so most of the edges ended in empty space. Both come
            out of the same geometry now, and an edge is given a block and a
            side rather than a destination, so it cannot land anywhere but on a
            port.
          */}
          <svg
            width={PREVIEW_SIZE.width}
            height={PREVIEW_SIZE.height}
            viewBox={`0 0 ${PREVIEW_SIZE.width} ${PREVIEW_SIZE.height}`}
          >
            <defs>
              {(["next", "rework", "question"] as const).map((tone) => (
                <marker
                  key={tone}
                  id={`draft-arrow-${tone}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                  className={`draft-arrow tone-${tone}`}
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" />
                </marker>
              ))}
            </defs>

            {PREVIEW_EDGES.map((edge) => (
              <path
                key={edge.id}
                className={`anim-edge tone-${edge.tone}`}
                style={{ animationDelay: `${edge.delay}s` }}
                d={previewPath(edge)}
                pathLength={1}
                markerEnd={`url(#draft-arrow-${edge.tone})`}
              />
            ))}

            {PREVIEW_NODES.map((node) => (
              <g
                key={node.id}
                className="anim-node"
                style={{ animationDelay: `${node.delay}s` }}
              >
                <rect
                  className="anim-node-body"
                  x={node.x}
                  y={node.y}
                  width={node.w}
                  height={node.h}
                  rx={node.pill ? node.h / 2 : 9}
                />
                {node.tone === "plain" ? null : (
                  <rect
                    className={`anim-node-rule tone-${node.tone}`}
                    x={node.x}
                    y={node.y + 1}
                    width={4}
                    height={node.h - 2}
                    rx={2}
                  />
                )}
              </g>
            ))}
          </svg>
          <i className="anim-sweep" />
        </div>
      </div>

      <div className="slab">
        <ol className="stage-list">
          {STAGES.map((item, index) => {
            const state = index < at ? "done" : index === at ? "now" : "next";
            return (
              <li key={item.id} className={`stage ${state}`}>
                <span className="stage-mark" aria-hidden="true" />
                <span>{item.label}</span>
                <span className="spacer" />
                {state === "now" ? <span className="stage-note">in progress</span> : null}
                {state === "done" ? <span className="stage-note done">done</span> : null}
              </li>
            );
          })}
        </ol>
        <p className="hint">
          Usually under a minute. Anthill is not showing the interpreter's
          working — nothing counts as part of a workflow until a complete draft has
          been validated.
        </p>
      </div>

      <div className="row">
        <button onClick={onCancel}>Cancel</button>
        <span className="hint">Cancelling leaves your prompt untouched.</span>
      </div>
    </>
  );
}
