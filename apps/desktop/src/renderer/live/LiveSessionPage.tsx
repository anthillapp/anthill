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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  CLI_LABEL,
  foldLiveSession,
  hasStepEvidence,
  isWatching,
  statusLabel,
  type AttributedEvent,
  type ObservationEvent,
  type PendingRun,
} from "@anthill/live";

import { agentProfiles } from "@anthill/workflow";

import { LIVE_SESSION_CHANNELS } from "../../shared/ipc.js";
import { useIpcHealth } from "../ipc-health.js";
import { relative, spanned, useNow } from "./elapsed.js";
import {
  buildFeed,
  FEED_FILTERS,
  FEED_LIMIT,
  matchesFilter,
  type FeedFilter,
} from "./feed.js";
import { FeedCardView } from "./FeedCard.js";
import { PresenceChip, PresencePlaque } from "./PresenceChip.js";
import { presenceKey } from "./presence.js";
import { INTERPRETER_LOGOS } from "../workflow/interpreter-logos.js";
import { LiveWorkflowGraph } from "./LiveWorkflowGraph.js";
import { SessionSummary, summaryDue } from "./SessionSummary.js";
import { RestartRequired } from "./RestartRequired.js";
import { RUN_STATE } from "./run-state.js";

export type LiveSessionPageProps = {
  workflow: Workflow;
  run: PendingRun;
  onBack: () => void;
  /** Stops Anthill observing. Never touches the external session. */
  onStopObserving: (runId: string) => void;
  /** What the CLI this run belongs to can expose, when it is known. */
  observation?: { available: boolean; note: string };
};

/**
 * Why the activity list looks the way it does.
 *
 * Five different situations used to render as the same blank panel, and only
 * one of them meant "nothing has happened yet". Naming them apart is the whole
 * fix: an empty feed is a statement about the session, and Anthill may only
 * make it when it was actually able to look.
 */
type FeedState =
  /** Still asking. */
  | { kind: "loading" }
  /** The process behind this screen is older than the screen. */
  | { kind: "restart-required" }
  /** Asking for the events failed, and it is not a version problem. */
  | { kind: "failed"; detail: string }
  /** This CLI writes nothing on this machine that Anthill can read. */
  | { kind: "unobservable"; detail: string }
  /** Anthill looked, and the session has genuinely done nothing yet. */
  | { kind: "empty" }
  /** There are events. */
  | { kind: "events" };

function clock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function LiveSessionPage({
  workflow,
  run,
  onBack,
  onStopObserving,
  observation,
}: LiveSessionPageProps) {
  const now = useNow();
  const [events, setEvents] = useState<ObservationEvent[]>([]);
  const [selectedBlock, setSelectedBlock] = useState<string | undefined>();
  const [openEvent, setOpenEvent] = useState<number | undefined>();
  /**
   * How the feed is ordered and filtered.
   *
   * Newest first by default: a session that keeps going would otherwise push
   * the latest thing that happened off the bottom of the panel.
   */
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
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
   * and the reader is owed the difference. A delegation's *steps* are counted
   * — the delegate announces them and they move the diagram — while its turns
   * are not written into this session's transcript at all, so its messages
   * are the one part that cannot appear in the feed (ANT-54).
   *
   * That is a fact about the record, not about Anthill's reading of it: across
   * every transcript on the machine this was measured on, `isSidechain` is
   * present and false throughout, and Codex's rollouts have no subagent
   * concept to record in the first place. So the feed is not hiding a message
   * it received; there was never one to receive, and saying so beats leaving a
   * gap the reader has to explain to themselves.
   */
  const delegated = useMemo(
    () => events.some((event) => event.kind === "subagent.start"),
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
  const doneCount = Object.values(view.blocks).filter((block) => block.state === "done").length;

  /**
   * The events this panel is currently about.
   *
   * Scope first — a selected block narrows the feed to what was tied to it —
   * then the filter, then the order. The counts shown in the controls row are
   * of this list, so what the header claims and what the feed holds cannot
   * disagree.
   */
  const scoped = useMemo<AttributedEvent[]>(
    () =>
      selectedBlock
        ? view.events.filter((event) => event.mapping.blockId === selectedBlock)
        : view.events,
    [view.events, selectedBlock],
  );

  /**
   * A settled run changes what an unfinished tool call is called: while the
   * session runs it is still working, and once the session is over its outcome
   * is unknown. Saying "unknown" is the point — nothing recorded a failure.
   */
  const settled =
    run.state === "completed" || run.state === "failed" || run.state === "observation_lost";

  /*
    The feed draws a window; the diagram above it does not.

    Both used to come from one truncated list, so a session past a thousand
    events lost the steps it announced early — the graph was folded from a
    record whose beginning had scrolled away, and blocks that had run for an
    hour went back to "Waiting its turn" (ANT-73). The fold now gets
    everything and the cap sits here, on what is rendered, which is the cost
    it was always meant to bound.
  */
  const cards = useMemo(
    () => buildFeed(scoped, settled).slice(-FEED_LIMIT),
    [scoped, settled],
  );

  /**
   * The newest arrival, held as one id rather than a flag on a card.
   *
   * A card's id is its opening event's seq, so it survives the start→end
   * update in place: an arrival is a card that was not here before, never a
   * card that changed. Holding the id also means the next arrival takes the
   * mark away from the one before it, so the drop-in plays exactly once and
   * cannot replay on a filter change, a re-order, or any other re-render —
   * which is what marking "whichever card is at the top" did.
   *
   * The first read is not an arrival. Everything in it was already there
   * before this screen opened, and animating one of them would claim
   * something just happened.
   */
  const newest = cards.length > 0 ? cards[cards.length - 1].id : undefined;
  const [arrived, setArrived] = useState<number | undefined>();
  const seen = useRef<number | undefined>();
  useEffect(() => {
    if (newest === undefined || newest === seen.current) return;
    const first = seen.current === undefined;
    seen.current = newest;
    setArrived(first ? undefined : newest);
  }, [newest]);

  const filtered = useMemo(() => cards.filter((card) => matchesFilter(card, filter)), [cards, filter]);
  const shown = useMemo(
    () => (sort === "newest" ? [...filtered].reverse() : filtered),
    [filtered, sort],
  );

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
        ? `quiet for ${relative(view.lastSeenAt, now).replace(" ago", "")} — the session is still there`
        : `nothing read for ${relative(view.lastSeenAt, now).replace(" ago", "")} — it may still be running`
      : undefined;

  const agentLabel = useCallback(
    (blockId: string | undefined) => {
      if (!blockId) return undefined;
      const node = workflow.nodes.find((item) => item.id === blockId);
      const agentId = node ? (node.config as { agentId?: string }).agentId : undefined;
      if (!agentId) return undefined;
      return agentProfiles(workflow).find((profile) => profile.id === agentId)?.name;
    },
    [workflow],
  );

  const blockName = useCallback(
    (blockId: string | undefined) =>
      blockId ? (workflow.nodes.find((node) => node.id === blockId)?.name ?? blockId) : undefined,
    [workflow.nodes],
  );

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

  const selectedName = selectedBlock
    ? (workflow.nodes.find((node) => node.id === selectedBlock)?.name ?? selectedBlock)
    : undefined;

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
          {watching ? "Anthill is observing, not running" : "Anthill observed this session; it never ran it"}
        </span>
        {watching ? (
          <button
            onClick={stop}
            title={`Only Anthill stops observing. Your ${CLI_LABEL[run.selectedCli]} session continues unchanged.`}
          >
            Stop observing in Anthill
          </button>
        ) : null}
      </header>

      <div className="live-page-body">
        <aside className="live-rail">
          <span className="kicker">This session</span>

          <dl className="live-rail-facts">
            <dt>Workflow</dt>
            <dd>{run.workflowName ?? workflow.name}</dd>
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
              <code>{run.evidenceChannel ?? "—"}</code>
              {run.confidence ? <span className={`conf conf-${run.confidence}`}>{run.confidence}</span> : null}
            </dd>
            <dt>Started</dt>
            <dd>{view.startedAt ? clock(view.startedAt) : "—"}</dd>
            {/*
              How long the run has been going, and no longer than that.

              A session Anthill is still reading is measured to now and ticks
              with the clock above. One that has finished, failed, or gone
              where Anthill cannot see it is measured to the last thing
              actually observed — counting past that would be claiming time
              nobody watched.
            */}
            <dt>Elapsed</dt>
            <dd>{spanned(view.startedAt, settled ? (view.lastSeenAt ?? run.lastObservedAt) : now)}</dd>
            <dt>Last seen</dt>
            <dd>{relative(view.lastSeenAt ?? run.lastObservedAt, now)}</dd>
          </dl>

          <div className="live-rail-cannot">
            <span className="kicker">What Anthill cannot tell you</span>
            <ul>
              <li>Whether the agent is actually following the workflow.</li>
              <li>Why it took one path rather than another.</li>
              <li>Anything the CLI does not write down on this machine.</li>
              {delegated ? (
                <li>
                  What a subagent said. This session delegated work, and the record keeps the
                  delegation and the moment it ended — never the delegate&rsquo;s own turns.
                  The steps it announced still count; its messages were not written down to
                  show.
                </li>
              ) : null}
              {handedOff ? (
                <li>
                  What another agent did with the work this session handed over — the record
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
                right now instead of waiting. Nothing is sent to the session — it never knew
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
                  : mapped
                    ? `${doneCount} of ${stepCount} steps finished`
                    : `${stepCount} steps · none announced yet`}
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

          {runsWorkflow && summaryDue(run) ? (
            <SessionSummary workflow={workflow} run={run} events={view.events} />
          ) : null}

          {runsWorkflow ? (
            <LiveWorkflowGraph
              workflow={workflow}
              view={view}
              sessionState={run.state}
              {...(selectedBlock ? { selectedBlockId: selectedBlock } : {})}
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
              activity. Nothing below has been ruled out — it simply has not been read.
            </p>
          ) : !mapped && feed.kind !== "loading" ? (
            <p className="live-stage-note">
              This session has not announced a step yet, so no block can be shown as running.
              Anthill only moves a block when the agent prints its Anthill step marker.
            </p>
          ) : null}

          <div className="live-legend" hidden={!runsWorkflow}>
            {(["queued", "running", "needsYou", "done", "failed", "unknown"] as const).map((state) => (
              <span key={state} className="live-legend-item">
                <i className={`live-swatch state-${state}`} style={{ background: RUN_STATE[state].line }} />
                {RUN_STATE[state].label}
              </span>
            ))}
          </div>
        </main>

        <aside className="live-side">
          <section className="live-activity">
            {/* A live feed grows, so nothing that states the current scope may
                live inside the scrolling area — it would scroll away exactly
                when the feed is long enough for you to need it. */}
            <header className="live-activity-top">
              <h2>Activity</h2>
              {selectedBlock ? (
                <span className="scope-chip">
                  {selectedName}
                  <span className="scope-count">{scoped.length}</span>
                  <button
                    className="scope-clear"
                    aria-label="Show the whole session"
                    onClick={() => setSelectedBlock(undefined)}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <span className="scope-whole">Whole session {view.events.length}</span>
              )}
            </header>

            <div className="live-activity-controls">
              <label className="sr-label" htmlFor="activity-order">
                Order
              </label>
              <select
                id="activity-order"
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>

              <span className="spacer" />
              <span className="activity-count">
                {filtered.length === cards.length
                  ? `${cards.length} card${cards.length === 1 ? "" : "s"}`
                  : `${filtered.length} of ${cards.length}`}
              </span>
            </div>

            <div className="feed-filters" role="group" aria-label="Filter activity">
              {FEED_FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={filter === item.key}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="live-activity-body">
            <p className="live-note">
              Event metadata written by {CLI_LABEL[run.selectedCli]} on this machine, plus one
              line of each message the agent addressed to you — code, credential-shaped text and
              Anthill's own markers removed. No full transcript, and none of the model's
              reasoning.
            </p>

            {feed.kind === "restart-required" && health.status === "stale" ? (
              <RestartRequired health={health} feature="Live Session" />
            ) : null}

            {feed.kind === "failed" ? (
              <p className="live-feed-problem" role="alert">
                Anthill could not read this run's activity, so this list is not a statement
                that nothing happened. {feed.detail}
              </p>
            ) : null}

            {feed.kind === "unobservable" ? (
              <p className="live-feed-problem" role="alert">
                {feed.detail} Anthill cannot observe this session, so there is nothing to
                show here — which is not the same as nothing happening.
              </p>
            ) : null}

            {feed.kind === "loading" ? <p className="empty">Reading what Anthill has observed…</p> : null}

            {feed.kind === "empty" || (feed.kind === "events" && shown.length === 0) ? (
              <p className="empty">
                {view.empty
                  ? "Nothing recorded yet. Anthill is reading the records this CLI writes as it goes."
                  : selectedBlock && cards.length === 0
                    ? `Nothing mapped to this step. It may not have started, or ${CLI_LABEL[run.selectedCli]} may not write records Anthill can tie to it.`
                    : "Nothing matches this filter."}
              </p>
            ) : null}

            <div className="live-feed">
              {shown.map((card) => (
                <FeedCardView
                  key={card.id}
                  card={card}
                  {...(runsWorkflow && card.blockId
                    ? { blockName: blockName(card.blockId) as string }
                    : {})}
                  {...(runsWorkflow && agentLabel(card.blockId)
                    ? { agentLabel: agentLabel(card.blockId) as string }
                    : {})}
                  // Only newest-first: under oldest-first the arrival lands at
                  // the bottom and a drop-in would point the wrong way.
                  isNew={card.id === arrived && sort === "newest"}
                />
              ))}
            </div>
            </div>
          </section>

        </aside>
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
