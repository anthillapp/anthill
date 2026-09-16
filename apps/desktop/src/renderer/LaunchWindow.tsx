/**
 * The first screen: what you already have, and three ways to start.
 *
 * It replaces a mode picker that asked the author to choose between a finished
 * mode and an unfinished one — which is not a choice — and hid the thing they
 * had actually come back for: their existing workflows. Xcode's launch window is
 * the reference, mirrored: actions on the left, recents on the right.
 *
 * No dark chrome bar. This is a launch panel rather than the main window, so
 * the pane runs to the top and the window's own title bar is the only one;
 * every screen after this keeps the app's dark chrome. The prototype draws its
 * own traffic lights because it has no real window — those are scaffolding and
 * do not ship, or the author would see two sets.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { isWatching, type LiveSessionState, type PendingRun } from "@anthill/live";

import type { HarnessTarget } from "@anthill/workflow-schema";

import type { CodexModelCatalog, LiveSnapshot, RecentWorkflow } from "../shared/ipc.js";
import { AgentEditor } from "./agents/AgentEditor.js";
import { AgentList } from "./agents/AgentList.js";
import { useAgentLibrary } from "./agents/useAgentLibrary.js";
import { useHarnessConnections } from "./harness/useHarnessConnections.js";
import { AnthillMark } from "./AnthillMark.js";
import { WorkflowPicker } from "./workflow/WorkflowPicker.js";

export type LaunchWindowProps = {
  /** Start from a template, or blank. */
  onNewWorkflow: () => void;
  /** Describe the work and let a local CLI propose a workflow. */
  onFromPrompt: () => void;
  /** Open a workflow. With no path, the author is asked for one. */
  onOpen: (path?: string) => void;
  /** Open a workflow straight onto its live session. */
  onOpenLive?: (path: string, run: PendingRun) => void;
  /** Open the explainer screen. */
  onExplain: () => void;
};

/**
 * How a workflow with an observation reads in the list.
 *
 * Keyed by `LiveSessionState` so a state cannot go unrepresented: add one to
 * the union and this stops compiling until it has been given a chip. Only a
 * confident match pulses — an unsure one must never look live.
 *
 * Which *group* a row lands in is not decided here, because the state alone
 * does not say it. A session that has just gone quiet is still being watched
 * and can come back on its own; the same state hours later, after Anthill gave
 * up, is history. `isWatching` knows the difference.
 */
const CHIP: Record<LiveSessionState, { label: string; tone: string; pulse: boolean }> = {
  idle: { label: "", tone: "idle", pulse: false },
  detected_live: { label: "Live", tone: "live", pulse: true },
  ambiguous_match: { label: "Ambiguous session", tone: "unsure", pulse: false },
  observation_lost: { label: "Observation lost", tone: "unsure", pulse: false },
  pending_after_copy: { label: "Waiting for a session", tone: "waiting", pulse: false },
  failed: { label: "Session failed", tone: "bad", pulse: false },
  completed: { label: "Finished", tone: "done" , pulse: false },
};

/** A workflow, plus the observation Anthill has for it, if any. */
type Row = RecentWorkflow & { run?: PendingRun };

/** "Today 14:20", "Yesterday", "26 Aug" — near dates read faster as words. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - at.getTime()) / 86_400_000);

  if (at.getTime() >= midnight.getTime()) {
    return `Today ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (days === 0) return "Yesterday";
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function LaunchWindow({
  onNewWorkflow,
  onFromPrompt,
  onOpen,
  onOpenLive,
  onExplain,
}: LaunchWindowProps) {
  /**
   * The welcome shows itself once, on the first start, and stays a click away
   * afterwards. `welcomeDue` reads a per-machine flag, so returning authors go
   * straight to their workflows.
   */
  const [recents, setRecents] = useState<RecentWorkflow[] | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  /** The agents list keeps its own needle: one field, but two lists. */
  const [agentFilter, setAgentFilter] = useState("");
  /** What just happened to a row, so a removal is never silent. */
  const [note, setNote] = useState<string | undefined>();
  /**
   * Which library the right pane is showing.
   *
   * Two lists, not two screens: an agent profile is written before there is a
   * workflow to put it in, so it belongs on the screen you are already looking
   * at when you have one — not behind a navigation that leaves the workflows.
   */
  const [pane, setPane] = useState<"workflows" | "agents">("workflows");

  /**
   * Held here rather than in either pane: the list is on the right and the
   * editor replaces the intro on the left, so which profile is open is a fact
   * about the window and not about one of its halves.
   */
  const agents = useAgentLibrary(recents);

  /**
   * What coding tools this machine has, asked once for the window.
   *
   * The same detection the prompt-to-workflow sheet uses — one question with
   * one answer, rather than two screens that can disagree about the author's
   * own computer.
   */
  const connections = useHarnessConnections();
  /**
   * Codex's own model catalogue, read once for the window.
   *
   * Asked for rather than hard-coded: a copy of somebody else's model list kept
   * in Anthill's source goes stale on their release schedule, and a stale entry
   * here becomes an agent file that fails at the far end.
   */
  const [codex, setCodex] = useState<CodexModelCatalog | undefined>();
  useEffect(() => {
    let live = true;
    void window.anthill
      .codexModels()
      .then((found) => {
        if (live) setCodex(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  /** Which tool's connection panel the editor has open, if any. */
  const [connecting, setConnecting] = useState<HarnessTarget | undefined>();

  useEffect(() => {
    let live = true;
    void window.anthill.listRecentPlans().then((found) => {
      if (!live) return;
      setRecents(found);
      setSelected(found[0]?.path);
    });

    // Which of these workflows has a session Anthill is following. A failure here
    // costs the chips, not the list — the workflows are still openable.
    window.anthill
      .liveSnapshot()
      .then((next) => {
        if (live) setSnapshot(next);
      })
      .catch(() => undefined);
    const off = window.anthill.onLiveSnapshot((next) => setSnapshot(next));

    return () => {
      live = false;
      off();
    };
  }, []);

  /** Each workflow with the newest observation that belongs to it. */
  const rows = useMemo<Row[]>(() => {
    const runs = snapshot?.runs ?? [];
    return (recents ?? []).map((workflow) => {
      // Matched on the workflow's own id: two files can share a name, and a chip on
      // the wrong row is worse than no chip.
      const run = workflow.workflowId
        ? runs.find((item) => item.workflowId === workflow.workflowId)
        : undefined;
      return run ? { ...workflow, run } : workflow;
    });
  }, [recents, snapshot]);

  /**
   * The step each live session last announced.
   *
   * Read from the run's own journal, and only for a session actually being
   * followed — the chip says "Live · Run tests" because a step the agent
   * announced is a fact, and it is the one thing worth knowing at a glance.
   */
  const [steps, setSteps] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const wanted = rows.filter((row) => row.run?.state === "detected_live");
    if (wanted.length === 0) return;

    void Promise.all(
      wanted.map(async (row) => {
        const events = await window.anthill.liveEvents(row.run!.anthillRunId).catch(() => []);
        const last = [...events].reverse().find((event) => event.blockId);
        const name = last?.blockId ? (row.steps?.[last.blockId] ?? last.blockId) : undefined;
        return [row.run!.anthillRunId, name] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      setSteps(
        Object.fromEntries(pairs.filter((pair): pair is [string, string] => Boolean(pair[1]))),
      );
    });

    return () => {
      live = false;
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.displayPath.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  /**
   * Two groups: what is happening, and what happened.
   *
   * Sessions holds only what Anthill is still watching — including a session
   * that has gone quiet, because the observers keep their place in its files
   * and it comes back by itself the moment it writes again. Once Anthill has
   * given up, the row drops to the workflow list still labelled for what happened,
   * because a session nobody is watching is not news.
   */
  const sessions = shown.filter((item) => item.run && isWatching(item.run));
  const rest = shown.filter((item) => !sessions.includes(item));

  /**
   * Take a workflow off this list.
   *
   * It leaves the list; the file stays exactly where it is. Anthill did not
   * create these files and has no business deleting them, and a Delete key that
   * quietly removed someone's work from disk would be the worst possible
   * reading of one keystroke — so the row says out loud what it did.
   */
  const forget = useCallback(
    async (row: Row) => {
      const remaining = (recents ?? []).filter((item) => item.path !== row.path);
      // Keep the keyboard where it was: the next row down, or the last one.
      const index = (recents ?? []).findIndex((item) => item.path === row.path);
      setRecents(remaining);
      setSelected(remaining[Math.min(index, remaining.length - 1)]?.path);
      // Nothing is said on success. The row leaving the list is the whole
      // message, and a notice explaining a removal the author just asked for
      // — in the same red as a failure — reads as though something went wrong.
      setNote(undefined);

      await window.anthill.forgetRecentWorkflow(row.path).catch(() => {
        // Putting it back is more honest than leaving a row missing from a
        // list that still has it.
        setRecents(recents ?? []);
        setNote("That workflow could not be removed from the list.");
      });
    },
    [recents],
  );

  /**
   * Delete removes the selected workflow from the list.
   *
   * Ignored while the filter field has focus, where Delete is what you press to
   * correct a typo, and the shortcut that ate it would be a bad trade.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
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
      const row = rows.find((item) => item.path === selected);
      if (!row) return;
      event.preventDefault();
      void forget(row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, forget]);

  const open = useCallback(
    (row: Row) => {
      if (row.run?.state === "detected_live" && onOpenLive) onOpenLive(row.path, row.run);
      else onOpen(row.path);
    },
    [onOpen, onOpenLive],
  );

  /**
   * The editor resolves from the selection *and* the tab, so switching to
   * Workflows cannot leave a half-open profile filling the other pane.
   */
  const editing = pane === "agents" ? agents.selected : undefined;

  /**
   * Leaving the Agents tab is the third way out of the editor, so it asks the
   * same question the other two do rather than dropping the draft on the way.
   */
  const goTo = useCallback(
    (next: "workflows" | "agents") => {
      if (next === pane) return;
      if (next === "workflows") agents.leave(() => setPane("workflows"));
      else setPane("agents");
    },
    [agents, pane],
  );

  return (
    <div className="launch">
      {/* The intro is centred in its pane; the editor fills it. One class,
          because they are two contents of one pane rather than two panes. */}
      <div className={`launch-left${editing ? " is-editing" : ""}`}>
        {editing && agents.draft ? (
          <AgentEditor
            profile={editing}
            draft={agents.draft}
            usedBy={agents.usedBy(editing.id)}
            justCreated={agents.justCreated === editing.id}
            confirming={agents.confirming === editing.id}
            dirty={agents.dirty}
            saveState={agents.saveState}
            leaving={agents.leaving}
            connections={connections}
            codex={codex}
            connecting={connecting}
            onConnect={setConnecting}
            onPatch={agents.patch}
            onSave={() => void agents.save()}
            onSaveAndLeave={() => void agents.saveAndLeave()}
            onDiscardAndLeave={agents.discardAndLeave}
            onStay={agents.stay}
            onDuplicate={() => agents.duplicate(editing.id)}
            onDelete={() => void agents.remove(editing.id)}
            onClose={agents.close}
          />
        ) : (
          <LaunchIntro
            onNewWorkflow={onNewWorkflow}
            onFromPrompt={onFromPrompt}
            onOpen={onOpen}
            onExplain={onExplain}
          />
        )}
      </div>

      <div className="launch-right">
        {/* One header for both lists. The tabs are ink-filled rather than
            accent-filled: the accent belongs to actions, and a tab is a view.
            A `group` rather than a `tablist`, because the two lists are not
            two panels of one widget — each owns the whole pane. */}
        <div className="launch-list-head">
          <div className="launch-tabs" role="group" aria-label="Launch library">
            <LaunchTab
              label="Workflows"
              count={recents?.length ?? 0}
              current={pane === "workflows"}
              onClick={() => goTo("workflows")}
            />
            <LaunchTab
              label="Agents"
              count={agents.count}
              current={pane === "agents"}
              onClick={() => goTo("agents")}
            />
          </div>
          <span className="spacer" />
          <div className="launch-filter">
            <span aria-hidden="true">⌕</span>
            <input
              value={pane === "agents" ? agentFilter : filter}
              placeholder={
                pane === "agents" ? "Filter by name or model" : "Filter by name or path"
              }
              aria-label={pane === "agents" ? "Filter agents" : "Filter recent workflows"}
              onChange={(event) =>
                pane === "agents" ? setAgentFilter(event.target.value) : setFilter(event.target.value)
              }
            />
          </div>
          {/* Only here: the workflow list already has its three create actions
              in the left pane, and a second one would be a duplicate. */}
          {pane === "agents" ? (
            <button type="button" className="btn-new-agent" onClick={agents.create}>
              + New agent
            </button>
          ) : null}
        </div>

        {pane === "agents" ? (
          <AgentList
            profiles={agents.profiles}
            groups={agents.groups}
            selectedId={agents.selected?.id}
            filter={agentFilter}
            note={agents.note}
            usedBy={agents.usedBy}
            onOpen={agents.open}
          />
        ) : (
          <>
        {note ? (
          <p className="launch-note is-said" role="status">
            {note}
          </p>
        ) : null}

        <div className="launch-recents">
          {recents === null ? (
            <p className="launch-note">Looking for your workflows…</p>
          ) : null}

          {recents !== null && recents.length === 0 ? (
            // Nothing to come back to yet, so say what to do instead of showing
            // an empty box.
            <p className="launch-note">
              No workflows yet. Create one, or describe the work and let a CLI draft it.
            </p>
          ) : null}

          {recents !== null && recents.length > 0 && shown.length === 0 ? (
            <p className="launch-note">Nothing matches “{filter.trim()}”.</p>
          ) : null}

          {sessions.length > 0 ? (
            <div className="launch-group">
              <span className="launch-group-head is-sessions">
                Sessions
                <i className="rule" />
                <span className="count">{sessions.length}</span>
              </span>
              {sessions.map((item) => (
                <RecentRow
                  key={item.path}
                  row={item}
                  selected={item.path === selected}
                  onSelect={() => {
                    setSelected(item.path);
                    setNote(undefined);
                  }}
                  onOpen={() => open(item)}
                  {...(item.run && steps[item.run.anthillRunId]
                    ? { step: steps[item.run.anthillRunId] }
                    : {})}
                />
              ))}
            </div>
          ) : null}

          {rest.length > 0 ? (
            <div className="launch-group">
              {sessions.length > 0 ? (
                <span className="launch-group-head">
                  Recent workflows
                  <i className="rule" />
                  <span className="count">{rest.length}</span>
                </span>
              ) : null}
              {rest.map((item) => (
                <RecentRow
                  key={item.path}
                  row={item}
                  selected={item.path === selected}
                  onSelect={() => {
                    setSelected(item.path);
                    setNote(undefined);
                  }}
                  onOpen={() => open(item)}
                />
              ))}
            </div>
          ) : null}
        </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The left pane when no agent profile is open: what Anthill is, and the three
 * ways to start. It moved into its own component when the profile editor took
 * the same space — the pane holds one of two things, and neither is a mode.
 */
function LaunchIntro({
  onNewWorkflow,
  onFromPrompt,
  onOpen,
  onExplain,
}: {
  onNewWorkflow: () => void;
  onFromPrompt: () => void;
  onOpen: (path?: string) => void;
  onExplain: () => void;
}) {
  /*
    Ask for the file here, and leave this screen only once there is one.

    Handing the workflow screen an "open" with no path made it mount with
    nothing to show, so it fell back to the template picker — and the file
    dialog opened on top of a page about starting a workflow from scratch,
    which is not what was asked for. Cancelling then left the author on that
    page rather than where they pressed the button.

    The dialog is the whole of this action, so it belongs to the button. The
    file is read again by the screen that opens it; that keeps one path for
    actually loading a workflow, which is the part worth not duplicating.
  */
  // The candidates the CLI offered in place of a file dialog, if any.
  const [pickerCandidates, setPickerCandidates] = useState<string[] | null>(null);

  const onChooseFile = useCallback(async (path?: string) => {
    const result = await window.anthill.openWorkflow(path);
    if (result.ok) {
      onOpen(result.opened.path);
      setPickerCandidates(null);
    } else if ("candidates" in result && result.candidates) {
      // The CLI has no file dialog; it offers the workflow files it knows
      // about. Show the picker; a pick is a second call with the path.
      setPickerCandidates(result.candidates);
    }
  }, [onOpen]);

  return (
    <>
      <AnthillMark className="launch-mark" size={104} />
      <h1>Anthill</h1>
      {/* From package.json at build time. It was a literal, and it drifted —
          the screen said 0.4 while the manifest said 0.0.1, and the disk image
          was named after the manifest. */}
      <p className="launch-version">
        Version {__ANTHILL_VERSION__} · local-first
        {/*
          Which Anthill this is.

          Two of them run on this machine — the one in /Applications and the
          one served from the repo — and they look identical while behaving
          differently, because the repo is usually several fixes ahead. Telling
          them apart by version number stops working the moment a release
          catches up. `import.meta.env.DEV` is true only when the renderer is
          being served by the dev server, which is exactly the distinction.
        */}
        {import.meta.env.DEV ? <span className="launch-dev">dev build</span> : null}
      </p>
      <p className="launch-blurb">
        Design a workflow for AI coding agents, then hand the workflow to the agent
        that carries it out.
      </p>

      <div className="launch-actions">
        <LaunchAction
          glyph="+"
          title="Create New Workflow"
          subtitle="Start from a template, or blank"
          onClick={onNewWorkflow}
        />
        <LaunchAction
          glyph="✎"
          title="Workflow from a Prompt"
          subtitle="Describe the work; a local CLI proposes a workflow"
          onClick={onFromPrompt}
        />
        <LaunchAction
          glyph="⌸"
          title="Open Existing Workflow"
          subtitle="A .workflow.json file on this machine"
          onClick={() => void onChooseFile()}
        />
      </div>

      <button type="button" className="launch-welcome-link" onClick={onExplain}>
        How Anthill works
      </button>

      <p className="launch-foot">Turn an idea into a workflow</p>

      {pickerCandidates && (
        <WorkflowPicker
          candidates={pickerCandidates}
          onPick={(path) => void onChooseFile(path)}
          onClose={() => setPickerCandidates(null)}
        />
      )}
    </>
  );
}

/**
 * One tab, with the size of the list behind it.
 *
 * `aria-current` rather than `aria-selected`: these are two views of the pane
 * rather than the panels of a tablist widget, and the count is part of the
 * label so a screen reader hears "Agents, 6" instead of two loose words.
 */
function LaunchTab({
  label,
  count,
  current,
  onClick,
}: {
  label: string;
  count: number;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="launch-tab"
      {...(current ? { "aria-current": "true" as const } : {})}
      onClick={onClick}
    >
      {label}
      <span className="launch-tab-count">{count}</span>
    </button>
  );
}

/**
 * One workflow, as a rule rather than a tile.
 *
 * A tile said "document"; the thing that actually matters about a row here is
 * its state, so the mark is a coloured rule down its left edge and the row
 * itself is the action — click to select, double-click to open. That is why the
 * footer's Open button is gone: it duplicated a gesture the row already had.
 */
function RecentRow({
  row,
  selected,
  onSelect,
  onOpen,
  step,
}: {
  row: Row;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** The step this session last announced, when it has announced one. */
  step?: string;
}) {
  const chip = row.run ? CHIP[row.run.state] : undefined;

  return (
    <button
      className={`launch-recent${selected ? " is-selected" : ""}`}
      title={
        selected
          ? "Enter or double-click to open · Delete to take it off this list"
          : "Click to select · double-click to open"
      }
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <i className={`recent-mark tone-${chip?.tone ?? "none"}`} aria-hidden="true" />
      <span className="recent-body">
        <span className="recent-name">{row.name}</span>
        <span className="recent-path">{row.displayPath}</span>
        <span className="recent-meta">{row.meta}</span>
      </span>
      <span className="recent-right">
        {chip && chip.label ? (
          <span className={`recent-chip tone-${chip.tone}${chip.pulse ? " is-pulsing" : ""}`}>
            {step ? `${chip.label} · ${step}` : chip.label}
          </span>
        ) : null}
        <span className="recent-when">
          {row.run ? liveWhen(row.run) : when(row.modifiedAt)}
        </span>
      </span>
    </button>
  );
}

/**
 * When a session is involved, a date is the wrong answer.
 *
 * "26 Aug" tells you nothing about a session that started four minutes ago, so
 * a watched workflow reports the observation's clock instead of the file's.
 */
function liveWhen(run: PendingRun): string {
  // Measured from the copy, because that is what the word says. Using the last
  // observation would make "copied 5s ago" mean "last seen 5s ago", which is a
  // different fact wearing the same sentence.
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(run.createdAt)) / 1000));
  if (run.state === "detected_live") {
    return `started ${new Date(run.createdAt).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  if (seconds < 60) return `copied ${seconds}s ago`;
  if (seconds < 3600) return `copied ${Math.floor(seconds / 60)}m ago`;
  return `copied ${Math.floor(seconds / 3600)}h ago`;
}

function LaunchAction({
  glyph,
  title,
  subtitle,
  onClick,
}: {
  glyph: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button className="launch-action" onClick={onClick}>
      <i aria-hidden="true">{glyph}</i>
      <span>
        <span className="launch-action-title">{title}</span>
        <span className="launch-action-sub">{subtitle}</span>
      </span>
    </button>
  );
}
