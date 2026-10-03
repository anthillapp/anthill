/**
 * The Live Session page: what Anthill can see of a session it did not start.
 *
 * Read-only, and structurally so. There is exactly one button on this page that
 * does anything at all — `Stop observing in Anthill` — and it stops Anthill
 * reading. Nothing here can reach the user's Codex or Claude Code session,
 * because Anthill holds no connection to it, and a control that implied
 * otherwise would be the single worst thing this page could ship.
 *
 * Three surfaces, each answering a different question:
 *
 * - the **graph** answers "where has the workflow got to", and only moves on a step
 *   the agent announced;
 * - the **feed** answers "what has actually happened", including everything
 *   that could not be tied to a step, because hiding those would make the graph
 *   look more complete than the evidence is;
 * - **what Anthill cannot tell you** answers the question a live view invites
 *   and usually dodges.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  CLI_LABEL,
  foldLiveSession,
  finishedSteps,
  hasStepEvidence,
  isWatching,
  sessionMetrics,
  statusLabel,
  type ObservationEvent,
  type PendingRun,
} from "@anthill/live";

import { LIVE_SESSION_CHANNELS } from "../../shared/ipc.js";
import type { BoundWorkflowResult } from "../../shared/ipc.js";
import { useIpcHealth } from "../ipc-health.js";
import { relative, spanned, useNow } from "./elapsed.js";
import { buildFeed, type FeedFilter } from "./feed.js";
import { ActivityPanel, type ActivityScope, type FeedState } from "./ActivityPanel.js";
import { PresenceChip, PresencePlaque } from "./PresenceChip.js";
import { presenceKey } from "./presence.js";
import { LiveWorkflowGraph } from "./LiveWorkflowGraph.js";
import { compact, endStateOf, outcomes, sessionUsage } from "./report.js";
import { SessionReport } from "./SessionReport.js";
import { UsagePanel } from "./UsagePanel.js";
import { RUN_STATE } from "./run-state.js";
import { UnsupportedWindowsChip } from "../windows/unsupported-windows.js";
import { interpreterLogoBackground } from "../workflow/interpreter-logos.js";

export type LiveSessionPageProps = {
  storageError?: string;
  workflow: Workflow;
  run: PendingRun;
  onBack: () => void;
  /** Stops Anthill observing. Never touches the external session. */
  onStopObserving: (runId: string) => void;
  /** What the CLI this run belongs to can expose, when it is known. */
  observation?: { available: boolean; note: string };
};

function clock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * The graph a run was started from, which is never the one on the canvas.
 *
 * A session is evidence of what the agent was asked to follow, so its diagram
 * has to be the copy taken when the run bound and not whatever the editor has
 * open. Drawing the open workflow meant editing it redrew a session that had
 * already finished — the steps moved, the names changed, and the record of
 * what actually ran was gone.
 *
 * Two places hold that copy, because runs arrive two ways. A handover's is the
 * exchange revision the run bound, read back by number. An ordinary run's is
 * the snapshot the run store wrote when it started, which it has kept all
 * along and nothing was reading.
 */
type GraphResult = { ok: true; workflow: Workflow } | { ok: false; error: string };

async function startedFrom(run: PendingRun, open?: Workflow): Promise<GraphResult> {
  if (run.exchange) return window.anthill.liveWorkflow(run.anthillRunId);
  const stored = await window.anthill.getRun(run.anthillRunId);
  if (stored?.snapshot) return { ok: true, workflow: stored.snapshot as unknown as Workflow };
  /*
   * A run the store has not caught up with yet.
   *
   * This is the moment between starting a run and its record landing, and in
   * it the open workflow is the one it started from — nobody has had time to
   * edit anything. Falling back is right here and would not be a moment later,
   * which is why the snapshot is preferred whenever there is one.
   */
  if (open) return { ok: true, workflow: open };
  return { ok: false, error: "This run's workflow snapshot has not been stored, so its diagram cannot be drawn." };
}

export function LiveSessionPage(props: LiveSessionPageProps) {
  const [snapshot, setSnapshot] = useState<{ runId: string; result: GraphResult }>();
  const [retry, setRetry] = useState(0);
  const { run } = props;
  useEffect(() => {
    let current = true;
    setSnapshot(undefined);
    const read = async () => {
      try {
        const result = await startedFrom(run, props.workflow);
        if (current) setSnapshot({ runId: run.anthillRunId, result });
      } catch (error) {
        if (current) setSnapshot({ runId: run.anthillRunId, result: { ok: false, error: String(error) } });
      }
    };
    void read();
    return () => { current = false; };
  }, [run.anthillRunId, run.exchange?.revision, retry]);
  const result = snapshot?.runId === run.anthillRunId ? snapshot.result : undefined;
  if (!result?.ok) return (
    <div className="app live-page">
      <header className="topbar"><button onClick={props.onBack}>Back to workflow</button><span>Live session</span></header>
      <p role={result ? "alert" : "status"}>{result ? result.error : "Reading the workflow this run started from..."}</p>
      {result ? <button onClick={() => setRetry((value) => value + 1)}>Retry reading it</button> : null}
    </div>
  );
  return <LiveSessionContent {...props} workflow={result.workflow} />;
}

function LiveSessionContent({
  workflow,
  run,
  onBack,
  onStopObserving,
  observation,
  storageError,
}: LiveSessionPageProps) {
  const now = useNow();
  const [events, setEvents] = useState<ObservationEvent[]>([]);
  /**
   * What the feed is narrowed to: one step, or every step an agent was
   * assigned. A step is also what the graph selects; an agent selects nothing
   * on the graph, because it is not one block.
   */
  const [scope, setScope] = useState<ActivityScope>();
  const selectedBlock = scope?.kind === "block" ? scope.blockId : undefined;
  const setSelectedBlock = useCallback(
    (blockId: string | undefined) => setScope(blockId ? { kind: "block", blockId } : undefined),
    [],
  );
  /** Here rather than in the panel: the session report opens the feed on one. */
  const [filter, setFilter] = useState<FeedFilter>("all");
  /** Set when reading or subscribing to the log fails for any other reason. */
  const [feedError, setFeedError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  // Checked before subscribing, not after: a subscription to a channel the
  // running process does not serve never fires, and waiting for it is how this
  // page used to sit empty for an hour.
  const health = useIpcHealth(LIVE_SESSION_CHANNELS);

  useEffect(() => {
    if (health.status !== "ok") return;

    let live = true;
    setFeedError(undefined);

    window.anthill
      .liveEvents(run.anthillRunId)
      .then((initial) => {
        if (!live) return;
        setEvents(initial);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        // Reaching here means the channel exists but the call failed — a real
        // fault rather than an out-of-date process, and it is shown as one.
        if (!live) return;
        setFeedError(error instanceof Error ? error.message : "Anthill could not read this run's activity.");
        setLoaded(true);
      });

    let off: (() => void) | undefined;
    try {
      off = window.anthill.onLiveEvents((payload) => {
        if (payload.runId === run.anthillRunId) setEvents(payload.events);
      });
    } catch (error: unknown) {
      setFeedError(
        error instanceof Error
          ? `Anthill could not follow this run's activity: ${error.message}`
          : "Anthill could not follow this run's activity.",
      );
    }

    return () => {
      live = false;
      off?.();
    };
  }, [run.anthillRunId, health.status]);

  const feed: FeedState =
    health.status === "checking"
      ? { kind: "loading" }
      : health.status === "stale"
        ? { kind: "restart-required" }
        : feedError
          ? { kind: "failed", detail: feedError }
          : events.length > 0
            ? { kind: "events" }
            : observation && !observation.available
              ? { kind: "unobservable", detail: observation.note }
              : loaded
                ? { kind: "empty" }
                : { kind: "loading" };

  const view = useMemo(
    () => foldLiveSession(workflow, run, events),
    [workflow, run, events],
  );

  const mapped = hasStepEvidence(view);

  /**
   * Whether this session handed work to another agent.
   *
   * Worth saying out loud, because it is the largest hole in what the page can
   * claim: the handover and the result are in this record, the work is not.
   * It is also why Anthill will not call such a session finished — see ANT-18.
   */
  const handedOff = useMemo(
    () => events.some((event) => event.toolName === "SendMessage"),
    [events],
  );

  /**
   * Whether this session delegated to a subagent.
   *
   * Kept apart from a handover because the two are missing different things
   * and the reader is owed the difference. A delegation's *steps* are counted:
   * the delegate announces them and they move the diagram.
   */
  const delegated = useMemo(
    () => events.some((event) => event.kind === "subagent.start"),
    [events],
  );

  /**
   * Whether this session's delegates are being read, rather than only counted.
   *
   * This used to be settled in advance, and settled wrongly. The reasoning was
   * that a delegate's turns are not written into the session's transcript, so
   * its messages could not appear in the feed — a fact about the record rather
   * than about Anthill's reading of it, and the page said so in as many words.
   *
   * The record had them all along. Claude Code files each delegate's own
   * transcript beside the session's, under `<sessionId>/subagents`, carrying
   * the parent's id and marked `isSidechain` throughout; the observer walked
   * one directory level and never looked inside (ANT-54). The measurement that
   * "isSidechain is present and false throughout" was taken over the one file
   * that could not contain a delegate's turn.
   *
   * So the question is answered by what actually arrived rather than by a
   * claim about what can: if a delegate's words are in the feed, the page has
   * nothing to apologise for, and Codex — which has no subagent concept to
   * record — still gets the honest note.
   */
  const readsDelegates = useMemo(
    () => events.some((event) => event.author?.kind === "subagent"),
    [events],
  );

  /**
   * Whether the workflow on the canvas is the one this run was started from.
   *
   * A run remembers its workflow's id and name, never the workflow itself, so a run
   * whose workflow is not open cannot have its steps drawn. Folding it against
   * whatever happens to be on the canvas produced a diagram of the wrong workflow
   * with every event in the session marked "no step" — a confident-looking
   * answer to a question Anthill was not in a position to answer.
   */
  const runsWorkflow = !run.workflowId || run.workflowId === workflow.id;
  const stepCount = Object.keys(view.blocks).length;
  const doneCount = finishedSteps(view);

  /**
   * The ended session's report (ANT-142), folded from the same view the graph
   * draws and the same journal the feed reads, so the three cannot disagree
   * and a restart rebuilds identical numbers.
   */
  const end = endStateOf(run);
  /*
    One end for the header, the report, the elapsed clock and the metrics
    (ANT-159): the moment the session said it was over when it said so, else
    the latest thing recorded. `closedAt` is when Anthill stopped reading,
    not when the work stopped, and is the last resort.
  */
  const lastRecordedAt = view.endedAt ?? view.lastSeenAt ?? run.lastObservedAt;
  const endedAt = end ? (lastRecordedAt ?? run.closedAt) : undefined;
  // Over the fold's own spans, so steps that ran side by side each keep
  // their own time and tokens (ANT-163).
  const metrics = useMemo(
    () => sessionMetrics(view.events, endedAt, view.spans),
    [view.events, endedAt, view.spans],
  );
  const usage = useMemo(
    () => sessionUsage(workflow, view, metrics, endedAt),
    [workflow, view, metrics, endedAt],
  );

  /**
   * A settled run changes what an unfinished tool call is called: while the
   * session runs it is still working, and once the session is over its outcome
   * is unknown. Saying "unknown" is the point — nothing recorded a failure.
   */
  const settled =
    run.state === "completed" || run.state === "failed" || run.state === "observation_lost";

  /*
    The whole session's items, folded once. The panel scopes, filters and
    caps them; folding before scoping keeps a tool call whose end named the
    step in the step it ran in, and keeps every call's subagent in view.
  */
  const cards = useMemo(() => buildFeed(view.events, settled), [view.events, settled]);

  /** Live splits into receiving and quiet; the rest come straight from state. */
  const presence = presenceKey(run, now);
  /**
   * The table's wording is generic because it cannot know the clock. Where the
   * real figure is known, say it — "quiet for 2m" tells the reader something
   * "quiet for a moment" does not.
   */
  const plaqueNote =
    (presence === "quiet" || presence === "lost") && view.lastSeenAt
      ? presence === "quiet"
        ? `quiet for ${relative(view.lastSeenAt, now).replace(" ago", "")} – the session is still there`
        : `nothing read for ${relative(view.lastSeenAt, now).replace(" ago", "")} – it may still be running`
      : undefined;

  const stop = useCallback(() => onStopObserving(run.anthillRunId), [onStopObserving, run.anthillRunId]);

  /**
   * Whether there is anything left to stop.
   *
   * This page has exactly one button that does something, and its whole design
   * rests on that button meaning one precise thing. Offering it on a session
   * that ended hours ago (ANT-32) asked to end something that had already
   * ended, and a control that does nothing teaches the reader that the
   * controls here are decorative — the opposite of what this page needs them
   * to believe.
   *
   * `isWatching` is the predicate rather than a hand-written state list: it is
   * what the launch window already uses to decide which runs are news, and it
   * keeps the button on a session that has merely gone quiet, which can still
   * come back on its own and is exactly when someone might want to stop.
   */
  const watching = isWatching(run);

  /**
   * Whether "Look again" is on offer.
   *
   * Only for a run Anthill was reading and then closed as lost. While a lost
   * run is still open it revives by itself the moment the session writes, so a
   * button would promise nothing the app is not already doing; and a cancelled
   * run cannot appear here at all, because cancelling removes the record.
   *
   * A closed one is also looked at again by itself, just more slowly (ANT-65),
   * so the button's remaining promise is "now" rather than "at all".
   */
  const canLookAgain = run.state === "observation_lost" && Boolean(run.closedAt);
  const [looking, setLooking] = useState(false);
  const lookAgain = useCallback(async () => {
    setLooking(true);
    try {
      await window.anthill.liveLookAgain(run.anthillRunId);
    } finally {
      setLooking(false);
    }
  }, [run.anthillRunId]);

  /** The ended session's progress, in the same words as the report's chips. */
  const endedProgress = (() => {
    if (!end) return undefined;
    if (end === "lost") return "progress unknown";
    const counted = outcomes(workflow, view);
    const n = (key: Parameters<typeof counted.get>[0]) => counted.get(key)?.length ?? 0;
    if (end === "failed") {
      return [n("failed") ? `${n("failed")} failed` : "", n("notReached") ? `${n("notReached")} not reached` : ""]
        .filter(Boolean)
        .join(" · ") || `${doneCount} of ${stepCount} steps finished`;
    }
    return `${doneCount} of ${stepCount} steps finished`;
  })();

  /** Tokens on each reached block of an ended session: "~42k in · 9k out", or "no token data". */
  const blockUsageNote = useMemo(() => {
    if (!end) return undefined;
    const notes: Record<string, string> = {};
    for (const block of usage.blocks) {
      if (block.passes.length === 0) continue;
      notes[block.blockId] = block.tokens ? `~${compact(block.tokens.in + block.tokens.out)} tokens` : "no token data";
    }
    return notes;
  }, [end, usage]);

  /** Which run, which session, read from where — provenance, not the result. */
  const technical = (
    <>
      {run.exchange ? <><dt>Bound revision</dt><dd>{run.exchange.revision}</dd></> : null}
      <dt>Anthill run</dt>
      <dd>
        <code>{run.anthillRunId}</code>
      </dd>
      <dt>Session</dt>
      <dd>
        {run.detectedSessionId ? (
          <code>{run.detectedSessionId}</code>
        ) : (
          <span className="quiet">not identified</span>
        )}
      </dd>
      <dt>Evidence</dt>
      <dd>
        <code>{run.evidenceChannel ?? "–"}</code>
        {run.confidence ? <span className={`conf conf-${run.confidence}`}>{run.confidence}</span> : null}
      </dd>
    </>
  );

  return (
    <div className="app live-page">
      <header className="topbar">
        <button className="icon-button" onClick={onBack} title="Back to the workflow">
          ←
        </button>
        <span className="live-page-title">Live session</span>
        <span className="live-page-workflow">{run.workflowName ?? workflow.name}</span>

        <span className="spacer" />
        {/* The boundary sentence is doing real work on this page, so it changes
            tense rather than disappearing with the button. */}
        <span className="live-page-boundary">
          {end === "lost"
            ? "Anthill lost contact with the session"
            : end === "stopped"
              ? "You stopped the session – Anthill never ran it"
              : end
              ? "Observation ended – Anthill never ran this session"
              : watching
                ? "Anthill is observing, not running"
                : "Anthill observed this session; it never ran it"}
        </span>
        {watching ? (
          <button
            onClick={stop}
            title={`Only Anthill stops observing. Your ${CLI_LABEL[run.selectedCli]} session continues unchanged.`}
          >
            Stop observing in Anthill
          </button>
        ) : null}
        <UnsupportedWindowsChip skin="on-dark" />
      </header>

      <div className="live-page-body">
        <aside className="live-rail">
          <span className="kicker">This session</span>

          <dl className="live-rail-facts">
            <dt>Workflow</dt>
            <dd>{run.workflowName ?? workflow.name}</dd>
            {/* While the session runs these identify what is being read and
                belong in view. Once it has ended they are provenance, and the
                report above the graph is what the reader came for, so they
                fold away into Technical details below. */}
            {end ? null : technical}
            <dt>Started</dt>
            <dd>{view.startedAt ? clock(view.startedAt) : "–"}</dd>
            {/*
              How long the run has been going, and no longer than that.

              A session Anthill is still reading is measured to now and ticks
              with the clock above. One that has finished, failed, or gone
              where Anthill cannot see it is measured to the last thing
              actually observed — counting past that would be claiming time
              nobody watched.
            */}
            <dt>Elapsed</dt>
            <dd>{spanned(view.startedAt, settled ? lastRecordedAt : now)}</dd>
            <dt>Last seen</dt>
            <dd>{relative(view.lastSeenAt ?? run.lastObservedAt, now)}</dd>
          </dl>

          {end ? (
            <details className="live-rail-details">
              <summary>Technical details</summary>
              <dl className="live-rail-facts">{technical}</dl>
            </details>
          ) : null}

          <div className="live-rail-cannot">
            <span className="kicker">What Anthill cannot tell you</span>
            <ul>
              <li>Whether the agent is actually following the workflow.</li>
              <li>Why it took one path rather than another.</li>
              <li>Anything the CLI does not write down on this machine.</li>
              {/* Moved here from the top of the Activity feed (ANT-268): the
                  boundary still has to be said, and the feed's header is now
                  only what the feed is showing. */}
              <li>
                The transcript itself. Anthill reads event metadata written by{" "}
                {CLI_LABEL[run.selectedCli]} on this machine, plus what the agent said to you
                &ndash; code, credential-shaped text and Anthill's own markers removed, and none
                of the model's reasoning.
              </li>
              {/*
                This list said, until ANT-54, that a subagent's words were not
                written down to show. They were — Claude Code files each
                delegate's own transcript beside the session's, and Anthill
                simply never opened the folder. The claim has to go with the
                limit: a page that keeps apologising for something it now does
                teaches the reader to discount the rest of this list.
              */}
              {delegated && !readsDelegates ? (
                <li>
                  What a subagent said. This session delegated work, and the record keeps the
                  delegation and the moment it ended – never the delegate&rsquo;s own turns.
                  The steps it announced still count; its messages were not written down to
                  show.
                </li>
              ) : null}
              {handedOff ? (
                <li>
                  What another agent did with the work this session handed over – the record
                  has the handover, not the work. While that is outstanding, a quiet session
                  is a session Anthill cannot see, not one that has finished.
                </li>
              ) : null}
            </ul>
          </div>

          {canLookAgain ? (
            <div className="live-rail-look">
              <button type="button" onClick={() => void lookAgain()} disabled={looking}>
                {looking ? "Reading the records…" : "Look again"}
              </button>
              <p className="hint">
                Anthill keeps checking this session&rsquo;s records every half-minute for a day
                and picks the session back up by itself if they grow. Look again reads them
                right now instead of waiting. Nothing is sent to the session – it never knew
                Anthill was reading.
              </p>
            </div>
          ) : null}

          <p className="live-rail-foot">
            Anthill did not start this session and cannot stop, pause or answer it.
          </p>
        </aside>

        <main className="live-stage">
          <div className="live-stage-chips">
            <span className="canvas-chip">Observed progress</span>
            {runsWorkflow ? (
              <span className="canvas-chip">
                {feed.kind === "restart-required" || feed.kind === "failed" || feed.kind === "loading"
                  ? `${stepCount} steps · progress unknown`
                  : !mapped
                    ? `${stepCount} steps · none announced yet`
                    : (endedProgress ?? `${doneCount} of ${stepCount} steps finished`)}
              </span>
            ) : (
              <span className="canvas-chip warn">this run&rsquo;s workflow is not open</span>
            )}
            {runsWorkflow && view.unmappedCount > 0 ? (
              <span className="canvas-chip warn" title="Anthill could not tie these to a step, and will not pretend otherwise.">
                {view.unmappedCount} event{view.unmappedCount === 1 ? "" : "s"} not mapped to a workflow step
              </span>
            ) : null}
            <span className="spacer" />
            <PresencePlaque presence={presence} {...(plaqueNote ? { note: plaqueNote } : {})} />
            <PresenceChip run={run} presence={presence} />
          </div>

          {runsWorkflow && end && feed.kind === "events" ? (
            <SessionReport
              workflow={workflow}
              run={run}
              view={view}
              end={end}
              usage={usage}
              {...(endedAt ? { endedAt } : {})}
              onPickBlock={setSelectedBlock}
              onUnmapped={() => {
                setScope(undefined);
                setFilter("unmapped");
              }}
            />
          ) : null}

          {runsWorkflow ? (
            <LiveWorkflowGraph
              workflow={workflow}
              view={view}
              sessionState={run.state}
              {...(selectedBlock ? { selectedBlockId: selectedBlock } : {})}
              {...(blockUsageNote ? { usageNote: blockUsageNote } : {})}
              onSelect={setSelectedBlock}
            />
          ) : (
            <p className="live-stage-note warn">
              This session was started from <strong>{run.workflowName ?? run.workflowId}</strong>,
              and the workflow open here is <strong>{workflow.name}</strong>. Anthill keeps a run&rsquo;s
              workflow by name, not the diagram itself, so there is nothing to draw its steps on. Open
              that workflow to see the graph. The activity below is still this session&rsquo;s own.
            </p>
          )}

          {!runsWorkflow ? null : feed.kind === "restart-required" || feed.kind === "failed" ? (
            <p className="live-stage-note warn">
              The diagram cannot be trusted while Anthill is unable to read this session's
              activity. Nothing below has been ruled out – it simply has not been read.
            </p>
          ) : !mapped && feed.kind !== "loading" ? (
            <p className="live-stage-note">
              This session has not announced a step yet, so no block can be shown as running.
              Anthill only moves a block when the agent prints its Anthill step marker.
            </p>
          ) : null}

          {runsWorkflow && end && feed.kind === "events" ? (
            <UsagePanel
              usage={usage}
              cli={run.selectedCli}
              onPickBlock={setSelectedBlock}
              onPickAgent={(name, blockIds) => setScope({ kind: "agent", name, blockIds })}
            />
          ) : null}

          <div className="live-legend" hidden={!runsWorkflow}>
            {(["queued", "running", "needsYou", "done", "failed", "unknown"] as const).map((state) => (
              <span key={state} className="live-legend-item">
                <i className={`live-swatch state-${state}`} style={{ background: RUN_STATE[state].line }} />
                {/* The graph's own words for a step the ended session skipped (ANT-193). */}
                {state === "queued" && (view.endedAt !== undefined || end === "completed" || end === "failed")
                  ? "Not reached"
                  : RUN_STATE[state].label}
              </span>
            ))}
            <span className="live-legend-item" title="The agent announced a step the workflow has no connection to from where it was.">
              <i className="live-swatch live-swatch-detour" />
              Unplanned move
            </span>
          </div>
        </main>

        <ActivityPanel
          workflow={workflow}
          runsWorkflow={runsWorkflow}
          view={view}
          cards={cards}
          feed={feed}
          health={health}
          {...(storageError ? { storageError } : {})}
          cli={{ label: CLI_LABEL[run.selectedCli], logo: interpreterLogoBackground(run.selectedCli) }}
          scope={scope}
          onClearScope={() => setScope(undefined)}
          filter={filter}
          onFilter={setFilter}
          usage={usage.blocks}
          ended={Boolean(end) || settled}
        />
      </div>

      <footer className="statusbar">
        <span className="path">{run.workflowId ?? workflow.id}</span>
        <span className="spacer" />
        <span>Observing since {view.startedAt ? clock(view.startedAt) : clock(run.createdAt)}</span>
        <span>
          {run.evidenceChannel ?? "no evidence"} · {run.confidence ?? "unknown"} confidence
        </span>
      </footer>
    </div>
  );
}

export default LiveSessionPage;
