/**
 * The Activity panel on the Live session page (ANT-268).
 *
 * A read-only feed of what the session did, rebuilt from what its CLI wrote
 * down. Two modes:
 *
 * - **Whole session**, with nothing selected on the canvas: every item.
 * - **Scoped to a block**, once a block is clicked: the header names it, the
 *   feed narrows to it, and an Activity | Block switcher appears — the
 *   block's own items, or the block as designed and as it ran.
 *
 * Nothing that states the current scope lives inside the scrolling area. A
 * live feed grows, and it would scroll away exactly when the feed is long
 * enough for the reader to need it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveSessionView } from "@anthill/live";
import type { Workflow } from "@anthill/workflow-schema";
import { blockColor } from "@anthill/builder";
import { agentConfig, agentProfiles } from "@anthill/workflow";

import type { IpcHealth } from "../ipc-health.js";
import { BlockTab } from "./BlockTab.js";
import {
  FEED_FILTERS,
  FEED_LIMIT,
  UNMAPPED_FILTER,
  matchesFilter,
  speakersOf,
  type FeedCard,
  type FeedFilter,
} from "./feed.js";
import { FeedCardView } from "./FeedCard.js";
import { earlyNote } from "./LiveWorkflowGraph.js";
import type { BlockUsage } from "./report.js";
import { RestartRequired } from "./RestartRequired.js";

/**
 * Why the activity list looks the way it does.
 *
 * Several different situations used to render as the same blank panel, and
 * only one of them meant "nothing has happened yet". Naming them apart is the
 * whole fix: an empty feed is a statement about the session, and Anthill may
 * only make it when it was actually able to look.
 */
export type FeedState =
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

/** What the feed is narrowed to: one step, or every step an agent was assigned. */
export type ActivityScope =
  | { kind: "block"; blockId: string }
  | { kind: "agent"; name: string; blockIds: string[] }
  | undefined;

export type ActivityPanelProps = {
  workflow: Workflow;
  /** Whether `workflow` is the one the run was started from, so its blocks can be named. */
  runsWorkflow: boolean;
  view: LiveSessionView;
  /** The whole session's items, oldest first. */
  cards: FeedCard[];
  feed: FeedState;
  health: IpcHealth;
  storageError?: string;
  /** The CLI's name and mark, for the session's own agent. */
  cli: { label: string; logo: string };
  scope: ActivityScope;
  onClearScope: () => void;
  filter: FeedFilter;
  onFilter: (filter: FeedFilter) => void;
  /** Per block, for the Block tab. */
  usage: BlockUsage[];
  /** Whether the session is over. */
  ended: boolean;
};

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="feed-empty">
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}

export function ActivityPanel({
  workflow,
  runsWorkflow,
  view,
  cards,
  feed,
  health,
  storageError,
  cli,
  scope,
  onClearScope,
  filter,
  onFilter,
  usage,
  ended,
}: ActivityPanelProps) {
  /**
   * How the feed is ordered.
   *
   * Newest first by default: a session that keeps going would otherwise push
   * the latest thing that happened off the bottom of the panel.
   */
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [tab, setTab] = useState<"activity" | "block">("activity");
  /** The one item whose tool output, or divider evidence, is open. */
  const [openId, setOpenId] = useState<number | undefined>();
  /** The one message showing all of itself. */
  const [moreId, setMoreId] = useState<number | undefined>();

  const blockId = scope?.kind === "block" ? scope.blockId : undefined;
  // A different block starts on its activity, not on whichever tab the last one was left on.
  useEffect(() => setTab("activity"), [blockId]);

  const node = useCallback((id: string | undefined) => (id ? workflow.nodes.find((item) => item.id === id) : undefined), [workflow.nodes]);

  const profileOf = useCallback(
    (id: string | undefined) => {
      if (!runsWorkflow) return undefined;
      const found = node(id);
      const agentId = found ? agentConfig(found).agentId : undefined;
      return agentId ? agentProfiles(workflow).find((profile) => profile.id === agentId)?.name : undefined;
    },
    [node, runsWorkflow, workflow],
  );

  /** Over the whole feed, so a scope cannot hide the subagent a call belongs to. */
  const speakers = useMemo(() => speakersOf(cards, profileOf), [cards, profileOf]);

  /**
   * Scope first, then the filter, then the order.
   *
   * The cap is a bound on rendering and sits after the scope, so a block
   * that ran early in a long session still shows its own items (ANT-73).
   */
  const scoped = useMemo(() => {
    if (!scope) return cards.slice(-FEED_LIMIT);
    const ids = new Set(scope.kind === "block" ? [scope.blockId] : scope.blockIds);
    // A divider for steps announced together belongs to each of them (ANT-296).
    const tied = (card: (typeof cards)[number]) =>
      (card.blockId !== undefined && ids.has(card.blockId)) || (card.steps?.some((id) => ids.has(id)) ?? false);
    return cards.filter(tied).slice(-FEED_LIMIT);
  }, [cards, scope]);
  const filtered = useMemo(() => scoped.filter((card) => matchesFilter(card, filter)), [scoped, filter]);
  const shown = useMemo(() => (sort === "newest" ? [...filtered].reverse() : filtered), [filtered, sort]);
  /*
    A step started while one the workflow runs apart from it was still at
    work, said on the divider that announced it (ANT-300): the latest divider
    naming the step at or before the moment it became plain.
  */
  const earlyNotes = useMemo(() => {
    const byCard = new Map<number, string[]>();
    for (const overlap of view.overlaps) {
      const at = Date.parse(overlap.at);
      let divider: (typeof cards)[number] | undefined;
      for (const card of cards) {
        if (card.kind !== "session" || !card.steps?.includes(overlap.step) || Date.parse(card.at) > at) continue;
        if (!divider || Date.parse(card.at) >= Date.parse(divider.at)) divider = card;
      }
      if (!divider) continue;
      const alongside = byCard.get(divider.id) ?? [];
      if (!alongside.includes(overlap.alongside)) alongside.push(overlap.alongside);
      byCard.set(divider.id, alongside);
    }
    return new Map([...byCard].map(([id, alongside]) => [id, earlyNote(workflow, alongside)]));
  }, [view.overlaps, cards, workflow]);

  /**
   * The newest arrival, held as one id rather than a flag on a card.
   *
   * A card's id is its opening event's seq, so it survives the start→end
   * update in place: an arrival is a card that was not here before, never a
   * card that changed. Holding the id also means the next arrival takes the
   * mark away from the one before it, so the drop-in plays exactly once and
   * cannot replay on a filter change, a re-order, or any other re-render.
   *
   * The first read is not an arrival. Everything in it was already there
   * before this screen opened, and animating one of them would claim
   * something just happened.
   */
  const newest = scoped.length > 0 ? scoped[scoped.length - 1].id : undefined;
  const [arrived, setArrived] = useState<number | undefined>();
  const seen = useRef<number | undefined>();
  useEffect(() => {
    if (newest === undefined || newest === seen.current) return;
    const first = seen.current === undefined;
    seen.current = newest;
    setArrived(first ? undefined : newest);
  }, [newest]);

  const blockOf = (id: string | undefined) => {
    if (!runsWorkflow) return undefined;
    const found = node(id);
    return found ? { name: found.name, color: blockColor(found) } : undefined;
  };

  const scopeName =
    scope?.kind === "agent" ? scope.name : blockId ? (node(blockId)?.name ?? blockId) : undefined;
  const showBlock = tab === "block" && blockId !== undefined && runsWorkflow;
  /** What the Block tab covers is out of reach of the keyboard as well as the eye. */
  const covered = useCallback(
    (element: HTMLElement | null) => {
      if (element) element.inert = showBlock;
    },
    [showBlock],
  );
  const filters = filter === "unmapped" ? [...FEED_FILTERS, UNMAPPED_FILTER] : FEED_FILTERS;

  return (
    <aside className="live-side">
      <header className="live-activity-top">
        <h2>Activity</h2>
        <span className="spacer" />
        {scope ? (
          <span className="scope-chip">
            <b>{scopeName}</b>
            <span className="scope-count">{shown.length}</span>
            <button
              type="button"
              className="scope-clear"
              aria-label="Show the whole session"
              title="Show the whole session"
              onClick={onClearScope}
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="scope-whole">
            Whole session<span className="scope-count">{shown.length}</span>
          </span>
        )}
      </header>

      {blockId !== undefined && runsWorkflow ? (
        <div className="activity-switch" role="tablist" aria-label="What to show for this block">
          {(["activity", "block"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {key === "activity" ? "Activity" : "Block"}
            </button>
          ))}
        </div>
      ) : null}

      {showBlock ? (
        <BlockTab
          workflow={workflow}
          blockId={blockId}
          state={view.blocks[blockId]?.state ?? "queued"}
          usage={usage.find((block) => block.blockId === blockId)}
          ended={ended}
          events={scoped.length}
          onShowEvents={() => setTab("activity")}
        />
      ) : null}

      {/* Covered by the Block tab rather than unmounted or hidden: hiding it
          would restart every animation in the feed each time the tab closed,
          and the reader comes back to the scroll position they left. */}
      <div ref={covered} className="feed-filters" role="group" aria-label="Filter activity" aria-hidden={showBlock || undefined}>
        {filters.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={filter === item.key}
            onClick={() => onFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
        <span className="spacer" />
        <label className="sr-label" htmlFor="activity-order">
          Order
        </label>
        <select id="activity-order" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      <div ref={covered} className="live-feed" aria-hidden={showBlock || undefined}>
        {feed.kind === "restart-required" && health.status === "stale" ? (
          <RestartRequired health={health} feature="Live Session" />
        ) : null}

        {storageError ? (
          <p className="live-feed-problem" role="alert">
            {storageError}
          </p>
        ) : null}

        {feed.kind === "loading" ? (
          <Empty title="Reading the journal">
            Anthill is rebuilding this session from the records already on disk.
          </Empty>
        ) : feed.kind === "failed" ? (
          <div role="alert">
            <Empty title="Anthill could not read the records">
              {feed.detail} This list is not a statement that nothing happened, and the session
              itself is unaffected.
            </Empty>
          </div>
        ) : feed.kind === "unobservable" ? (
          <div role="alert">
            <Empty title="This CLI writes nothing Anthill can read">
              {feed.detail} There is nothing to show here, which is not the same as nothing
              happening.
            </Empty>
          </div>
        ) : feed.kind === "empty" || (feed.kind === "events" && view.empty) ? (
          <Empty title="Nothing recorded yet">
            The session is live and Anthill is watching. The first record usually arrives within a
            few seconds.
          </Empty>
        ) : feed.kind === "events" && scope && scoped.length === 0 ? (
          <Empty title="Nothing mapped to this step">
            It may not have started, or {cli.label} may not write records Anthill can tie to it.
          </Empty>
        ) : feed.kind === "events" && shown.length === 0 ? (
          <Empty title="Nothing matches this filter">
            Try All to see everything Anthill has read for this session.
          </Empty>
        ) : null}

        {shown.map((card) => {
          const speaker = speakers.get(card.id);
          const block = blockOf(card.blockId);
          const stepNames = card.steps?.map((id) => blockOf(id)?.name ?? id);
          const note = earlyNotes.get(card.id);
          return (
            <FeedCardView
              key={card.id}
              card={card}
              cli={cli}
              {...(speaker ? { speaker } : {})}
              {...(block ? { block } : {})}
              {...(stepNames ? { stepNames } : {})}
              {...(note ? { note } : {})}
              open={openId === card.id}
              onToggle={() => setOpenId((id) => (id === card.id ? undefined : card.id))}
              expanded={moreId === card.id}
              onExpand={() => setMoreId((id) => (id === card.id ? undefined : card.id))}
              // Only newest-first: under oldest-first the arrival lands at
              // the bottom and a drop-in would point the wrong way.
              isNew={card.id === arrived && sort === "newest"}
            />
          );
        })}
      </div>
    </aside>
  );
}
