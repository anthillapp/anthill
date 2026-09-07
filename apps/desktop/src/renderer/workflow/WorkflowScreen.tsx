/**
 * Workflow mode: design a workflow as a diagram, get a prompt out.
 *
 * Nothing here executes anything — the output is text plus files the author
 * drops into their own repository.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NO_SELECTION,
  WorkflowCanvas,
  addNode,
  createNode,
  dropPosition,
  type LinkingState,
  type WorkflowSelection,
} from "@anthill/builder";
import {
  HARNESS_PROFILES,
  addAgentProfile,
  addOutput,
  agentProfiles,
  allIssues,
  assignAgent,
  findCycles,
  issuesForNode,
  nodesOnCycles,
  stepsUsingAgent,
  stampWorkflowFormat,
  validateWorkflow,
  withRunRoot,
  type WorkflowTemplate,
} from "@anthill/workflow";
import { HARNESS_TARGETS, type HarnessTarget, type Workflow } from "@anthill/workflow-schema";
import type { PendingRun } from "@anthill/live";

import { SAVED_LINGER_MS, isFailure, saveMessage, type SaveStatus } from "./save-status.js";
import { AgentEditor } from "./AgentLibrary.js";
import { type CustomBlock, type LibraryBlock } from "./BlockLibrary.js";
import { BlockInspector } from "./BlockInspector.js";
import { WorkflowLibraries, type LibraryTab } from "./WorkflowLibraries.js";
import { ProblemsPopover, type ProblemTarget } from "./ProblemsPopover.js";
import { OutputInspector } from "./OutputInspector.js";
import { PromptToWorkflowSheet } from "./PromptToWorkflowSheet.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { blankWorkflow } from "./sample-workflow.js";
import { PromptModal } from "./PromptModal.js";
import { DescribeChangeAssistant } from "./DescribeChangeAssistant.js";
import {
  canStepBack,
  canStepForward,
  emptyHistory,
  recordEdit,
  stepBack,
  stepForward,
  type History,
} from "./workflow-history.js";
import { AnthillMark } from "../AnthillMark.js";
import { LiveIndicator } from "../live/LiveIndicator.js";
import { PresencePlaque } from "../live/PresenceChip.js";
import { mostRelevant, presenceKey, runsFor } from "../live/presence.js";
import {
  markAnnounced,
  SessionStartedDialog,
  shouldAnnounce,
} from "../live/SessionStartedDialog.js";
import { LiveSessionPage } from "../live/LiveSessionPage.js";
import { ObservationSetupCard } from "../live/ObservationSetupCard.js";

export type WorkflowScreenProps = {
  onExit: () => void;
  /**
   * What the launch window sent the author here to do. Without it the workflow
   * would show its own start screen on top of the one they just used.
   */
  start?:
    | { kind: "templates" }
    | { kind: "prompt" }
    | { kind: "open"; path?: string; live?: PendingRun };
};

export function WorkflowScreen({ onExit, start }: WorkflowScreenProps) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  /**
   * Where the workflow has been, and where it was stepped back from.
   *
   * Every change goes through `editWorkflow`, so keeping history around that
   * one funnel covers the canvas, the inspector, the agent library and the
   * assistant at once — there is no per-surface undo to keep in step, because
   * there is only one place a change can happen.
   */
  const [history, setHistory] = useState<History<Workflow>>(() => emptyHistory<Workflow>());
  const [selection, setSelection] = useState<WorkflowSelection>(NO_SELECTION);
  const [linking, setLinking] = useState<LinkingState>(null);
  const [path, setPath] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  /** Held in a ref, not state: it gates the next call, it does not draw. */
  const saving = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryTab>("blocks");
  const [showProblems, setShowProblems] = useState(false);
  /** The pill the Problems index hangs from, measured rather than guessed. */
  const problemsPill = useRef<HTMLButtonElement>(null);
  /**
   * Where the inspector came from when an agent was opened from a step.
   *
   * Opening an agent from a block replaces what the inspector is showing, so it
   * owes the reader a way back to the step they were reading. Cleared by any
   * other selection, because a trail back to somewhere nobody was is noise.
   */
  const [agentReturn, setAgentReturn] = useState<string | undefined>();
  const [fromPrompt, setFromPrompt] = useState(start?.kind === "prompt");
  /**
   * True from the moment a drafted workflow lands until its assembly reveal
   * has run once. Only a draft assembles — an opened file or an edit draws at
   * once — and the flag drops on the first edit so the animation can never
   * replay over the author's own change.
   */
  const [assembling, setAssembling] = useState(false);
  const [custom, setCustom] = useState<CustomBlock[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [firstMeaningfulEdit, setFirstMeaningfulEdit] = useState(false);
  const [showLiveSetup, setShowLiveSetup] = useState(false);

  // Settings is reached from the menu bar (⌘,), not from this page: managing
  // observation is a job with no place in the handover flow that sets it up.
  useEffect(() => {
    try {
      return window.anthill.onOpenSettings(() => setShowLiveSetup(true));
    } catch {
      // An older main process without the channel. The flow still sets
      // observation up; only the management surface is out of reach.
      return undefined;
    }
  }, []);
  /**
   * Whether the Prompt modal is open.
   *
   * The prompt has one home now. It used to be a sidebar tab as well, which
   * made the thing the user actually leaves with feel like an inspector panel;
   * the sidebar is for editing the workflow, and this is the handover.
   */
  const [showPrompt, setShowPrompt] = useState(false);
  const [describing, setDescribing] = useState(false);
  /** Blocks the author pointed at for the assistant, as ids. */
  const [mentions, setMentions] = useState<string[]>([]);
  /**
   * The one way in and out of the assistant.
   *
   * The canvas pill and the sidebar's ✕ both call this, so they cannot
   * disagree — an earlier pass had the ✕ clearing the references and the pill
   * not, which left a reopened assistant pointing at blocks from a request
   * that was abandoned.
   */
  const toggleAssistant = useCallback(() => {
    setDescribing((on) => {
      if (on) setMentions([]);
      return !on;
    });
  }, []);
  /**
   * The observed session being looked at, if any.
   *
   * A page rather than a panel, and only reachable while a session is actually
   * live: every other observation state is a statement about what Anthill does
   * not know, and there is nothing honest to fill a page with.
   */
  const [liveRun, setLiveRun] = useState<PendingRun | null>(
    start?.kind === "open" && start.live ? start.live : null,
  );
  /** What the CLI behind the open live run can expose, as main reported it. */
  const [liveObservation, setLiveObservation] = useState<
    { available: boolean; note: string } | undefined
  >();

  /**
   * Keep the open live page's run in step with what main knows.
   *
   * The page was given a copy of the run when it opened and never a newer one,
   * so everything the page says *about the run* — the status chip, the
   * evidence, the last-seen time, and the final step, which only settles once
   * the run itself has — stayed frozen at the moment it was opened. A session
   * that finished went on being drawn as live indefinitely.
   *
   * A run that is no longer in the snapshot was cancelled or dismissed
   * elsewhere; the last thing known about it is kept rather than blanked, so
   * the page never loses what it was showing.
   */
  const [liveRuns, setLiveRuns] = useState<PendingRun[]>([]);

  useEffect(() => {
    let live = true;
    // Ask once as well as subscribing. A push only arrives when something
    // changes, so without this the canvas knows nothing about a session that
    // was already being observed when this screen opened — and the
    // announcement for it would never fire either.
    void window.anthill
      .liveSnapshot()
      .then((snapshot) => {
        if (live) setLiveRuns(snapshot.runs);
      })
      .catch(() => {
        // An older main process does not serve this channel. The indicator
        // reports that itself; the canvas simply stays quiet.
      });

    let off: (() => void) | undefined;
    try {
      off = window.anthill.onLiveSnapshot((snapshot) => {
        setLiveRuns(snapshot.runs);
        setLiveRun((current) => {
          if (!current) return current;
          const next = snapshot.runs.find(
            (candidate) => candidate.anthillRunId === current.anthillRunId,
          );
          return next ?? current;
        });
      });
    } catch {
      // An older main process does not serve this channel. The page still
      // works from the event feed; it just cannot refresh the run's own state,
      // and the health check on the page is what says so.
    }
    return () => {
      live = false;
      off?.();
    };
  }, []);

  /**
   * The run the canvas speaks for — the same one the chip features, and only
   * ever one started from the workflow that is open.
   */
  const watched = mostRelevant(runsFor(liveRuns, workflow?.id));

  /**
   * The one run still owed an announcement.
   *
   * Gated on a confirmed match and nothing weaker: a modal takes the author
   * off what they were doing, and "a session here might be yours" is not worth
   * that. Everything less certain stays in the chip, where a reader goes
   * looking rather than being pulled.
   */
  const [announcing, setAnnouncing] = useState<PendingRun | null>(null);
  useEffect(() => {
    if (!watched || !shouldAnnounce(watched)) return;
    markAnnounced(watched.anthillRunId);
    setAnnouncing(watched);
  }, [watched]);

  /** Open one agent in the inspector, remembering the step it came from. */
  const editAgent = useCallback(
    (agentId: string, from?: string) => {
      setSelectedAgent(agentId);
      setLibrary("agents");
      setAgentReturn(from);
    },
    [],
  );

  const selectStep = useCallback((nodeId: string) => {
    setSelection({ kind: "block", nodeId });
    setSelectedAgent(undefined);
    setAgentReturn(undefined);
  }, []);

  const validation = useMemo(
    () => (workflow ? validateWorkflow(workflow) : { valid: true, errors: [] }),
    [workflow],
  );
  const loops = useMemo(
    () => (workflow ? nodesOnCycles(workflow).size > 0 : false),
    [workflow],
  );

  /**
   * Record the dirty state where the main process can read it at close time.
   * Set synchronously: IPC is asynchronous, so an edit followed immediately by
   * a window close could otherwise be decided on a stale value.
   */
  const markDirty = useCallback((value: boolean) => {
    setDirty(value);
    (window as unknown as Record<string, unknown>).__anthillWorkflowDirty = value;
    void window.anthill.setWorkflowDirty(value);
  }, []);

  const editWorkflow = useCallback(
    (next: Workflow | ((current: Workflow) => Workflow)) => {
      setWorkflow((current) => {
        if (!current) return current;
        const after = typeof next === "function" ? next(current) : next;
        // Recorded here rather than by the caller: this is the one place that
        // knows both what is being left and what is arriving, and a caller
        // that forgot would leave a gap in the history nobody would notice.
        if (after !== current) setHistory((past) => recordEdit(past, current));
        return after;
      });
      setFirstMeaningfulEdit(true);
      // An edit mid-reveal ends the reveal: replaying an entrance over the
      // author's own change would animate something that is not new.
      setAssembling(false);
      markDirty(true);
    },
    [markDirty],
  );

  /**
   * Step the workflow back, or forward again.
   *
   * A step is not an edit: it does not push onto the history it is walking,
   * and it does not restart the assembly reveal. It does mark the file dirty,
   * because the workflow on screen now differs from the one on disk — that is
   * true whichever direction it was reached from.
   */
  const step = useCallback(
    (direction: "back" | "forward") => {
      if (!workflow) return;
      const walk = direction === "back" ? stepBack : stepForward;
      const taken = walk(history, workflow);
      if (!taken) return;
      // Everything here is a plain event handler, deliberately. An earlier
      // pass did this work inside a `setWorkflow` updater, which meant setting
      // other state during React's render phase: under StrictMode the updater
      // ran twice, the history advanced, and the workflow it was supposed to
      // restore never arrived — Step back moved the buttons and left the
      // canvas exactly as it was.
      setHistory(taken.history);
      setWorkflow(taken.state);
      markDirty(true);
      // What was selected may not exist in the state being restored, and an
      // inspector pointing at a block that is gone is worse than none.
      setSelection(NO_SELECTION);
      setSelectedAgent(undefined);
      setAgentReturn(undefined);
    },
    [workflow, history, markDirty],
  );

  /**
   * ⌘Z and ⇧⌘Z, the two shortcuts every editor has.
   *
   * Ignored while a text field has focus: there ⌘Z is the browser's own undo
   * of what was typed, and stealing it would make correcting a typo throw away
   * the whole edit instead.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      step(event.shiftKey ? "forward" : "back");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const replaceWorkflow = useCallback(
    (next: Workflow, nextPath?: string) => {
      setWorkflow(next);
      // A different workflow is a different history. Stepping back into the
      // one before it was opened would restore a file the author has left.
      setHistory(emptyHistory<Workflow>());
      setPath(nextPath);
      setSelection(NO_SELECTION);
      setLinking(null);
      setSelectedAgent(undefined);
      setAgentReturn(undefined);
      // Opening a file or a template draws at once. Only the accept handler
      // re-raises this, for the one workflow that is new to its reader.
      setAssembling(false);
      markDirty(false);
    },
    [markDirty],
  );

  useEffect(() => {
    markDirty(false);
    return () => markDirty(false);
  }, [markDirty]);


  const confirmDiscard = useCallback(
    (action: string) =>
      !dirty ||
      window.confirm(
        `This workflow has unsaved changes.\n\n${action} discards everything since the last save.`,
      ),
    [dirty],
  );

  const open = useCallback(async (path?: string) => {
    if (!confirmDiscard("Opening another workflow")) return;
    const result = await window.anthill.openWorkflow(path);
    if (!result.ok) {
      if ("cancelled" in result) return;
      setNotice(result.error);
      return;
    }
    replaceWorkflow(result.opened.workflow, result.opened.path);
    setNotice(result.opened.notice ?? null);
  }, [confirmDiscard, replaceWorkflow]);

  // Opening a workflow the launch window already chose: done once, on arrival.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || start?.kind !== "open") return;
    opened.current = true;
    void open(start.path);
  }, [start, open]);

  const save = useCallback(async () => {
    if (!workflow) return;
    // One press, one write. A second click while the first is in flight would
    // race it to the same file and could report the older answer last, so it
    // is dropped rather than queued — the save already running is the one the
    // author asked for (ANT-58).
    if (saving.current) return;
    saving.current = true;
    setSaveStatus({ kind: "saving" });
    try {
      const result = await window.anthill.saveWorkflow({
        workflow: stampWorkflowFormat(workflow),
        path,
      });
      if (result.kind === "saved") {
        setPath(result.path);
        markDirty(false);
        setNotice(null);
        setSaveStatus({ kind: "saved" });
        return;
      }
      // Cancelling is a decision, not a fault: nothing was written and nothing
      // is claimed. The dirty pill goes on saying what is true.
      setSaveStatus(result.kind === "failed" ? { kind: "failed", error: result.error } : { kind: "idle" });
    } catch (error) {
      setSaveStatus({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving.current = false;
    }
  }, [workflow, path, markDirty]);

  // "Saved" is about the click, so it goes when the click stops being recent.
  // A failure stays until something else happens: it is the author's to read.
  useEffect(() => {
    if (saveStatus.kind !== "saved") return;
    const timer = window.setTimeout(() => setSaveStatus({ kind: "idle" }), SAVED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const exit = useCallback(() => {
    if (!confirmDiscard("Leaving the workflow screen")) return;
    onExit();
  }, [confirmDiscard, onExit]);

  const newWorkflow = useCallback(() => {
    if (!confirmDiscard("Starting a new workflow")) return;
    setWorkflow(null);
    setFromPrompt(false);
    markDirty(false);
  }, [confirmDiscard, markDirty]);

  const startLinking = useCallback((nodeId: string, outputId: string) => {
    setLinking({ nodeId, outputId });
    setSelection({ kind: "output", nodeId, outputId });
    setSelectedAgent(undefined);
  }, []);

  /** Add a block from the library, at a given canvas point or a default spot. */
  const addFromLibrary = useCallback(
    (block: LibraryBlock, at?: { x: number; y: number }, canvasSize?: { width: number; height: number }) => {
      editWorkflow((current) => {
        const position =
          at && canvasSize
            ? dropPosition(at, canvasSize)
            : { x: 120 + current.nodes.length * 30, y: 160 + (current.nodes.length % 4) * 40 };

        const node = createNode(current, block.nodeType ?? "agent", {
          name: block.label,
          position,
          config: block.nodeType
            ? block.nodeType === "approval"
              ? { prompt: "" }
              : {}
            : { actionKind: block.actionKind, purpose: block.summary, task: "" },
        });

        let next = addNode(current, node);

        // A new step gets an agent of its own, so it is assignable straight
        // away. Pointing it at an existing agent is one choice in its
        // inspector; the alternative — leaving it unassigned — starts every
        // new step with a validation error.
        if (!block.nodeType) {
          const created = addAgentProfile(next, { name: "" });
          next = assignAgent(created.workflow, node.id, created.agentId);
        }

        if (block.nodeType === "end") return next;

        // Every new block starts with a way out, so the workflow can be continued
        // without first working out how to add an output. The Condition
        // control seeds two — a block with only one output has nothing to
        // route between.
        const outputCount = block.seedOutputs ?? 1;
        for (let i = 0; i < outputCount; i += 1) {
          next = addOutput(next, node.id).workflow;
        }
        return next;
      });
    },
    [editWorkflow],
  );

  if (!workflow) {
    if (fromPrompt) {
      return (
        <PromptToWorkflowSheet
          onCancel={() => setFromPrompt(false)}
          onAccept={(drafted) => {
            setFromPrompt(false);
            replaceWorkflow(drafted);
            // The accepted draft assembles on the canvas — the one time the
            // graph builds rather than appears, because this is the one time
            // the graph is new to the person looking at it.
            setAssembling(true);
            // A drafted workflow has never been saved, and closing without saving
            // it would lose it — so it starts dirty rather than pretending to
            // match a file on disk.
            markDirty(true);
          }}
        />
      );
    }
    return (
      <TemplatePicker
        onPick={(template: WorkflowTemplate) => replaceWorkflow(template.build())}
        onBlank={() => replaceWorkflow(blankWorkflow())}
        onOpen={() => void open()}
        onFromPrompt={() => setFromPrompt(true)}
        onCancel={onExit}
      />
    );
  }

  const selectedNode =
    selection.kind === "block"
      ? workflow.nodes.find((node) => node.id === selection.nodeId)
      : selection.kind === "output"
        ? workflow.nodes.find((node) => node.id === selection.nodeId)
        : undefined;

  const agents = agentProfiles(workflow);
  const issues = allIssues(validation);
  const cycles = findCycles(workflow);
  const outputCount = workflow.edges.length;

  /** Follow a problem to the thing it is about. */
  const goToProblem = (target: ProblemTarget) => {
    setSelectedAgent(undefined);
    setAgentReturn(undefined);
    if (target.kind === "block") setSelection({ kind: "block", nodeId: target.nodeId });
    else setSelection({ kind: "output", nodeId: target.nodeId, outputId: target.edgeId });
  };

  const selectedAgentProfile = agents.find((profile) => profile.id === selectedAgent);
  const returnStep = agentReturn
    ? workflow.nodes.find((node) => node.id === agentReturn)
    : undefined;

  const selectedIssues = selectedNode ? issuesForNode(validation, selectedNode.id) : [];

  /** What the one inspector is showing, and what its header says about it. */
  const inspecting: { title: string; count?: string } = selectedAgentProfile
    ? {
        title: "Agent profile",
        count: `${stepsUsingAgent(workflow, selectedAgentProfile.id).length} steps`,
      }
    : selection.kind === "output"
      ? { title: "Selected connection" }
      : selectedNode
        ? {
            title: "Selected block",
            ...(selectedIssues.length > 0 ? { count: `${selectedIssues.length} to fix` } : {}),
          }
        : { title: "Inspector" };

  if (liveRun && workflow) {
    return (
      <LiveSessionPage
        workflow={workflow}
        run={liveRun}
        {...(liveObservation ? { observation: liveObservation } : {})}
        onBack={() => setLiveRun(null)}
        onStopObserving={(runId) => {
          void window.anthill.liveCancel(runId);
          setLiveRun(null);
        }}
      />
    );
  }

  return (
    <div className="app">
      {announcing && workflow ? (
        <SessionStartedDialog
          run={announcing}
          workflowName={workflow.name}
          onOpenSession={() => {
            setLiveRun(announcing);
            setAnnouncing(null);
          }}
          onDismiss={() => setAnnouncing(null)}
        />
      ) : null}

      {showPrompt ? (
        <PromptModal
          workflow={workflow}
          validation={validation}
          onRunRoot={(root) => editWorkflow((current) => withRunRoot(current, root))}
          onClose={() => setShowPrompt(false)}
        />
      ) : null}

      <header className="topbar">
        <button className="icon-button" onClick={exit} title="Back to mode selection">
          ←
        </button>
        <AnthillMark className="logo-mark" size={22} />
        <span className="screen-name">Workflow</span>

        <input
          className="title-input"
          value={workflow.name}
          onChange={(event) =>
            editWorkflow((current) => ({ ...current, name: event.target.value }))
          }
          placeholder="Workflow name"
        />

        <label className="harness">
          <span>Harness</span>
          <select
            value={workflow.target ?? ""}
            onChange={(event) =>
              editWorkflow((current) => ({
                ...current,
                target: event.target.value as HarnessTarget,
              }))
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {HARNESS_TARGETS.map((target) => (
              <option key={target} value={target}>
                {HARNESS_PROFILES[target].displayName}
              </option>
            ))}
          </select>
        </label>

        <span className="spacer" />

        {dirty ? (
          <span className="pill dirty">
            <span className="dot" /> Unsaved
          </span>
        ) : null}

        {/* Announced politely and never focused: the author is told without
            being interrupted, and the caret stays where they left it. */}
        <span
          className={`save-status${isFailure(saveStatus) ? " is-failed" : ""}`}
          role="status"
          aria-live="polite"
        >
          {saveMessage(saveStatus)}
        </span>

        {validation.errors.length > 0 ? (
          <button
            className="pill problems"
            ref={problemsPill}
            onClick={() => setShowProblems((current) => !current)}
            aria-expanded={showProblems}
          >
            {validation.errors.length} to fix
          </button>
        ) : (
          <span className="pill on">Ready</span>
        )}

        <span className="divider" />
        {/* Beside the document actions, because that is what a step is: the
            whole workflow moving, not something inside it changing. */}
        <button
          className="icon-button"
          aria-label="Step back"
          title="Step back (⌘Z)"
          disabled={!canStepBack(history)}
          onClick={() => step("back")}
        >
          ↶
        </button>
        <button
          className="icon-button"
          aria-label="Step forward"
          title="Step forward (⇧⌘Z)"
          disabled={!canStepForward(history)}
          onClick={() => step("forward")}
        >
          ↷
        </button>

        <button onClick={newWorkflow}>New</button>
        <button onClick={() => void open()}>Open</button>
        <button onClick={save}>Save</button>
        {/* Not `disabled`: a button that cannot be clicked cannot say where to
            go instead. It looks unavailable and takes the author to the
            problems that made it so — but it never opens the handover, which
            is the pairing that matters and the one that broke once. */}
        <button
          className={`primary${validation.valid ? "" : " is-blocked"}`}
          aria-disabled={!validation.valid}
          onClick={() => (validation.valid ? setShowPrompt(true) : setShowProblems(true))}
          title={validation.valid ? undefined : "Fix the problems first"}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 1.5 L10 6 L2.5 10.5 Z" fill="currentColor" />
          </svg>
          Prompt
        </button>
      </header>

      {showProblems ? (
        <ProblemsPopover
          workflow={workflow}
          issues={issues}
          onClose={() => setShowProblems(false)}
          onGo={goToProblem}
          anchor={problemsPill}
        />
      ) : null}

      {notice ? (
        <div className="banner">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      ) : null}

      {/* Live Observation is step 2 of the Prompt flow now: it is offered where
          it is needed, in the order it is needed, rather than beside Save
          where a button gave no hint that hooks have a deadline. What is left
          here is the management surface — inspect, repair, disable — reached
          deliberately from Settings (⌘,) rather than shown unprompted. */}
      <ObservationSetupCard
        firstMeaningfulEdit={false}
        forceOpen={showLiveSetup}
        onClose={() => setShowLiveSetup(false)}
      />

      <div className="body">
        <WorkflowLibraries
          workflow={workflow}
          onChange={editWorkflow}
          tab={library}
          onTabChange={setLibrary}
          custom={custom}
          onAddCustom={(block) => setCustom((current) => [...current, block])}
          onAddBlock={(block) => addFromLibrary(block)}
          {...(selectedAgent ? { selectedAgentId: selectedAgent } : {})}
          onSelectAgent={(agentId) => {
            setSelectedAgent(agentId);
            setAgentReturn(undefined);
            if (agentId) setSelection(NO_SELECTION);
          }}
        />

        <div
          className="canvas-area"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const raw = event.dataTransfer.getData("application/anthill-block");
            if (!raw) return;
            const box = event.currentTarget.getBoundingClientRect();
            addFromLibrary(
              JSON.parse(raw) as LibraryBlock,
              { x: event.clientX - box.left, y: event.clientY - box.top },
              { width: box.width, height: box.height },
            );
          }}
        >
          <WorkflowCanvas
            workflow={workflow}
            onChange={editWorkflow}
            validation={validation}
            selection={selection}
            onSelectionChange={(next) => {
              setSelection(next);
              // Any canvas selection replaces what the inspector shows, so an
              // agent left open there stops being what is selected.
              setSelectedAgent(undefined);
              setAgentReturn(undefined);
            }}
            {...(describing
              ? {
                  onBlockPick: (nodeId: string) =>
                    setMentions((current) =>
                      current.includes(nodeId)
                        ? current.filter((id) => id !== nodeId)
                        : [...current, nodeId],
                    ),
                }
              : {})}
            linking={linking}
            onLinkingChange={setLinking}
            assembling={assembling}
          />

          {/* One cluster in the canvas's own coordinates: the plaque explains,
              the chip claims. Both sit outside the layer that pans and zooms,
              so neither drifts with the diagram. */}
          <div className="canvas-presence">
            {watched ? <PresencePlaque presence={presenceKey(watched)} /> : null}
            <LiveIndicator
              {...(workflow.id ? { workflowId: workflow.id } : {})}
              onOpenSession={(run, capability) => {
                setLiveRun(run);
                setLiveObservation(capability);
              }}
            />
          </div>

          {/* Anchored to the canvas, not the topbar: this edits the diagram,
              so it belongs to the diagram's own chrome rather than beside
              New/Open/Save/Prompt, which act on the document. */}
          <button
            type="button"
            className={`canvas-describe${describing ? " is-open" : ""}`}
            title={
              describing
                ? "Close the assistant and go back to editing by hand"
                : "Describe a change in words; a local CLI proposes it, you apply it"
            }
            onClick={toggleAssistant}
          >
            <i aria-hidden="true">{describing ? "⚙" : "✎"}</i>
            {describing ? "Edit manually" : "Describe a change"}
          </button>

          <div className="canvas-chips">
            <span className="pill">
              {workflow.nodes.length} blocks · {outputCount} connections ·{" "}
              {cycles.length} {cycles.length === 1 ? "loop" : "loops"}
            </span>
          </div>

          <div className="canvas-legend">
            <span>
              <i className="legend-line" style={{ borderColor: "#7d7979" }} /> next
            </span>
            <span>
              <i
                className="legend-line"
                style={{ borderColor: "#d8a21a", borderTopStyle: "dashed" }}
              />{" "}
              rework
            </span>
            <span>
              <i
                className="legend-line"
                style={{ borderColor: "#56aee0", borderTopStyle: "dotted" }}
              />{" "}
              question
            </span>
          </div>
        </div>

        <aside className="inspector">
          {/* The assistant replaces the inspector outright rather than sitting
              beside it as a tab: while it is open a canvas click references a
              block instead of selecting one, so there is nothing for an
              inspector to be showing. */}
          {describing ? (
            <DescribeChangeAssistant
              workflow={workflow}
              mentions={mentions}
              onMentionsChange={setMentions}
              onApply={(next) => editWorkflow(next)}
              onClose={toggleAssistant}
            />
          ) : (
            <>
          <header className="inspector-top">
            <h2>{inspecting.title}</h2>
            {inspecting.count ? <span className="count">{inspecting.count}</span> : null}
          </header>

          {selectedAgentProfile ? (
            <AgentEditor
              key={selectedAgentProfile.id}
              workflow={workflow}
              profile={selectedAgentProfile}
              onChange={editWorkflow}
              onSelect={setSelectedAgent}
              onSelectStep={selectStep}
              {...(returnStep
                ? {
                    backTo: {
                      label: returnStep.name || "the step",
                      go: () => selectStep(returnStep.id),
                    },
                  }
                : {})}
            />
          ) : selection.kind === "output" ? (
            <OutputInspector
              workflow={workflow}
              nodeId={selection.nodeId}
              outputId={selection.outputId}
              onChange={editWorkflow}
              onStartLinking={startLinking}
              onCleared={() => setSelection(NO_SELECTION)}
              onSelectStep={selectStep}
              validation={validation}
            />
          ) : selectedNode ? (
            <BlockInspector
              workflow={workflow}
              node={selectedNode}
              onChange={editWorkflow}
              onStartLinking={startLinking}
              onSelectOutput={(nodeId, outputId) =>
                setSelection({ kind: "output", nodeId, outputId })
              }
              onEditAgent={(agentId) => editAgent(agentId, selectedNode.id)}
              onSelectStep={selectStep}
              validation={validation}
            />
          ) : (
            <div className="inspector-idle">
              <h3>Nothing selected</h3>
              <p>Pick a block or a connection on the canvas, or an agent from the library.</p>
              <div className="chips">
                <span className="chip">
                  {workflow.nodes.length} {workflow.nodes.length === 1 ? "block" : "blocks"}
                </span>
                <span className="chip">
                  {agents.length} {agents.length === 1 ? "agent" : "agents"}
                </span>
                {validation.errors.length > 0 ? (
                  <span className="chip error">{validation.errors.length} to fix</span>
                ) : (
                  <span className="chip ok">nothing to fix</span>
                )}
              </div>
            </div>
          )}
            </>
          )}
        </aside>
      </div>

      <footer className="statusbar">
        <span className="path">{path ?? "Not saved yet"}</span>
        <span className="spacer" />
        <span>
          {workflow.target ? HARNESS_PROFILES[workflow.target].displayName : "No harness"}
        </span>
        <span>
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
        <span>
          {cycles.length === 0
            ? "no loops"
            : `${cycles.length} ${cycles.length === 1 ? "loop" : "loops"}`}
        </span>
      </footer>
    </div>
  );
}
