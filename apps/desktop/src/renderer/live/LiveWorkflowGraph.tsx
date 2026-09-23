/**
 * The workflow, as far as local records can show it.
 *
 * Read-only by construction: it reuses `buildCanvasModel` from the editor so
 * the diagram is laid out exactly as it was drawn, and it has no pointer
 * handling, no linking, and no `onChange`. Observing a session must not be a
 * way to edit the workflow behind it.
 *
 * The rule the whole component exists to keep: **a block only moves because the
 * agent announced that step.** Tool activity, however busy, leaves the diagram
 * alone. That is why a workflow whose agent never printed a marker shows every step
 * waiting rather than a plausible-looking guess — the page says so in words
 * instead of drawing something it cannot support.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HOST_EXCLUSIONS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  blockRect,
  buildCanvasModel,
  useDisplayLayout,
  useWheelZoom,
  zoomAbout,
  type Workflow,
} from "@anthill/builder";
import { agentConfig } from "@anthill/workflow";
import {
  hasStepEvidence,
  type BlockView,
  type LiveSessionState,
  type LiveSessionView,
} from "@anthill/live";
import { actionDefinition } from "@anthill/workflow";

import { EDGE_TONE, RUN_STATE, type DrawnRunState, type EdgeTone } from "./run-state.js";
import { useNow } from "./elapsed.js";
import { readDuration } from "./feed.js";

export type LiveWorkflowGraphProps = {
  workflow: Workflow;
  view: LiveSessionView;
  /**
   * The run's own state.
   *
   * Start and End have no announcement of their own to go on, so what they may
   * claim depends on whether the session is still being read.
   */
  sessionState: LiveSessionState;
  selectedBlockId?: string;
  onSelect: (blockId: string | undefined) => void;
};

export { ZOOM_MAX, ZOOM_MIN };

/** How far the pointer may travel and still count as a click, in pixels. */
const DRAG_SLOP = 4;

/**
 * Whether a pointer that went down at one place and moved to another was
 * dragging the diagram rather than clicking it.
 *
 * A slop rather than an exact comparison, because a hand resting on a trackpad
 * moves a pixel or two and that is still somebody clicking. Kept out of the
 * component because it is the one part of the pan guard worth testing on its
 * own: jsdom's pointer events carry no coordinates at all, so a pan cannot be
 * simulated at the component level and a test that appeared to do so would be
 * asserting the environment's silence rather than this rule.
 */
export function wasDrag(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > DRAG_SLOP;
}

/** Pan and zoom, the same shape the Workflow canvas uses. */
type Viewport = { x: number; y: number; scale: number };

function kicker(node: Workflow["nodes"][number]): string {
  if (node.type === "start") return "START";
  if (node.type === "end") return "END";
  if (node.type === "approval") return "APPROVAL";
  const kind = agentConfig(node).actionKind;
  return kind ? actionDefinition(kind).label.toUpperCase() : "STEP";
}

/**
 * A start or end block carries no work, so it takes the run's own shape.
 *
 * Start used to turn green the moment anything at all was read, which made a
 * session that had merely begun look like a workflow that had got under way.
 * The two are different facts, and the gap between them can be long: an agent
 * reads the prompt, opens files and runs a command before it announces its
 * first step. So Start is only finished once control has demonstrably left it —
 * some step was announced — and until then it says what is actually true, which
 * is that Anthill is watching and waiting. If the session ends without ever
 * announcing a step, Anthill never learned whether the workflow got past Start,
 * and `unknown` says so instead of guessing either way.
 */
/**
 * Whether every step the workflow has has finished.
 *
 * `every` over no blocks is vacuously true, so a session nothing has been
 * observed for would otherwise read as a completed one — hence the guard.
 */
function runFinished(view: LiveSessionView): boolean {
  return !view.empty && Object.values(view.blocks).every((block) => block.state === "done");
}

function boundaryState(
  view: LiveSessionView,
  node: Workflow["nodes"][number],
  sessionState: LiveSessionState,
): DrawnRunState {
  if (node.type === "start") {
    if (view.empty) return "queued";
    if (hasStepEvidence(view)) return "done";
    return sessionState === "detected_live" ? "observing" : "unknown";
  }
  return runFinished(view) ? "done" : "queued";
}

/**
 * When a block was last announced, as something two ends can be ordered by.
 *
 * `undefined` means the record cannot answer — the block was never entered, or
 * was entered without a usable timestamp. Callers must not read that as
 * "earlier": an absent time is a missing fact, not an early one.
 */
function enteredAt(block: BlockView | undefined): number | undefined {
  if (!block || block.passes < 1 || !block.enteredAt) return undefined;
  const at = Date.parse(block.enteredAt);
  return Number.isNaN(at) ? undefined : at;
}

function carriedControl(
  view: LiveSessionView,
  source: string,
  target: string,
  boundaryKind: (id: string) => "start" | "end" | undefined,
): boolean {
  if (boundaryKind(target) === "end") return runFinished(view);

  const to = view.blocks[target];
  if (!to || to.passes < 1) return false;

  if (boundaryKind(source) === "start") return true;

  const from = view.blocks[source];
  if (from?.state !== "done") return false;
  const left = enteredAt(from);
  const arrived = enteredAt(to);
  return !(left !== undefined && arrived !== undefined && arrived < left);
}

/**
 * Which connection most recently brought control to each step.
 *
 * Several connections arrive at the same step, and once a loop has come round
 * more than one of them will have carried work at some point. Exactly one did
 * so *last*, and only that one may pulse: "live" says control is arriving here
 * now, and that cannot be true of two lines at once — which is what the
 * diagram was claiming, with two dashed blue lines converging on one step
 * (ANT-53).
 *
 * The most recently entered source is the answer rather than a guess at it.
 * The fold tracks a single active step, so control was in exactly one place
 * before it reached this one, and the latest entry among the candidates is
 * where it was.
 *
 * A step whose candidates carry no usable time is left out entirely. Then
 * nothing is singled out and every arriving connection pulses, as before —
 * an unclear record should lose the distinction, not have one invented for it.
 */
function deliveringSources(
  workflow: Workflow,
  view: LiveSessionView,
  boundaryKind: (id: string) => "start" | "end" | undefined,
): Map<string, string> {
  const best = new Map<string, { source: string; at: number }>();
  for (const edge of workflow.edges) {
    if (!carriedControl(view, edge.source, edge.target, boundaryKind)) continue;
    const at = enteredAt(view.blocks[edge.source]);
    if (at === undefined) continue;
    const held = best.get(edge.target);
    if (!held || at > held.at) best.set(edge.target, { source: edge.source, at });
  }
  return new Map([...best].map(([target, held]) => [target, held.source]));
}

/**
 * How an edge is drawn, from what was observed at its two ends.
 *
 * An edge may only be drawn as taken once control demonstrably *arrived* at its
 * target. Leaving the source is not enough, and reading it as enough is what
 * ANT-55 was: a finished step that branches has several outgoing edges, control
 * went down exactly one of them, and colouring them all from the source alone
 * drew a green arrow into a checkpoint the run had not reached.
 *
 * Arrival on its own is not enough either, because a rework edge points back at
 * a step that has already run and would otherwise light up on the strength of
 * that first pass. So the two ends are ordered: only a target entered *after*
 * its source can have been reached along this edge.
 *
 * And of the connections that did carry control, only the one that carried it
 * last may pulse. The rest are drawn as travelled, which they were — earlier.
 */
function edgeTone(
  view: LiveSessionView,
  source: string,
  target: string,
  boundaryKind: (id: string) => "start" | "end" | undefined,
  delivering: Map<string, string>,
): EdgeTone {
  if (!carriedControl(view, source, target, boundaryKind)) return "idle";
  if (boundaryKind(target) === "end") return "seen";

  const to = view.blocks[target];
  const arriving = to?.state === "running" || to?.state === "needsYou";
  if (!arriving) return "seen";

  const last = delivering.get(target);
  return last === undefined || last === source ? "live" : "seen";
}

export function LiveWorkflowGraph({
  workflow: sourceWorkflow,
  view,
  sessionState,
  selectedBlockId,
  onSelect,
}: LiveWorkflowGraphProps) {
  // Through the hook, so a block this graph placed keeps the place it was
  // given. Called directly, every reflow of a workflow that arrived without
  // positions — a handover, drawn afresh — was free to put the same block
  // somewhere else, with nothing on the page to explain the move.
  const workflow = useDisplayLayout(sourceWorkflow);
  const model = useMemo(() => buildCanvasModel(workflow), [workflow]);
  const surface = useRef<HTMLDivElement>(null);
  /** For the running block's "so far" — the one figure on the graph that ticks. */
  const now = useNow();

  /**
   * Zoom and pan, held here rather than shared with the Workflow canvas.
   *
   * The behaviour is deliberately the same — the same limits, the same step,
   * the same ⌘+/−/0 — because someone who has learned it once should not have
   * to learn it again. The *implementation* is separate: this diagram is
   * read-only, has no ports, no linking and no dragging of blocks, and coupling
   * it to the editor's canvas would drag all of that along behind it.
   */
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const panFrom = useRef<{ x: number; y: number; origin: Viewport } | null>(null);
  /**
   * Whether the pointer travelled between going down and coming up.
   *
   * A pan ends with a click on the background, and a click on the background
   * clears the selection — so without this, dragging the diagram sideways
   * while reading a step would put that step away.
   */
  const dragged = useRef(false);

  /** Which end of the run a block is, for the two that carry no work. */
  const boundaryKind = useMemo(() => {
    const kinds = new Map<string, "start" | "end">();
    for (const node of workflow.nodes) {
      if (node.type === "start" || node.type === "end") kinds.set(node.id, node.type);
    }
    return (id: string) => kinds.get(id);
  }, [workflow]);

  /** Recomputed with the view, since it is entirely a fact about the events. */
  const delivering = useMemo(
    () => deliveringSources(workflow, view, boundaryKind),
    [workflow, view, boundaryKind],
  );

  const bounds = useMemo(() => {
    const rects = workflow.nodes.map((node) => blockRect(node));
    if (rects.length === 0) return { x: 0, y: 0, w: 800, h: 400 };
    const left = Math.min(...rects.map((r) => r.left)) - 90;
    const top = Math.min(...rects.map((r) => r.top)) - 90;
    const right = Math.max(...rects.map((r) => r.left + r.w)) + 90;
    const bottom = Math.max(...rects.map((r) => r.top + r.h)) + 110;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }, [workflow]);

  /** Frame the whole workflow, so an active step is never stranded off-screen. */
  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    // A container measured at nothing — before layout, or while hidden — would
    // otherwise produce a negative scale and turn the diagram inside out.
    if (!box || box.width <= 0 || box.height <= 0 || bounds.w <= 0 || bounds.h <= 0) {
      setViewport({ x: 0, y: 0, scale: 1 });
      return;
    }
    const margin = 48;
    const scale = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, Math.min((box.width - margin) / bounds.w, (box.height - margin) / bounds.h)),
    );
    setViewport({
      scale,
      x: (box.width - bounds.w * scale) / 2 - bounds.x * scale,
      y: (box.height - bounds.h * scale) / 2 - bounds.y * scale,
    });
  }, [bounds]);

  const zoomBy = useCallback((factor: number) => {
    const box = surface.current?.getBoundingClientRect();
    // Hold the middle of the view still, so zooming in on a small active step
    // does not send it off the edge.
    const focal = box ? { x: box.width / 2, y: box.height / 2 } : { x: 0, y: 0 };
    setViewport((current) => zoomAbout(current, factor, focal));
  }, []);

  /**
   * The same pinch and two-finger gestures as the editor's canvas.
   *
   * Shared through `@anthill/builder` rather than reimplemented, so the two
   * surfaces cannot drift into meaning slightly different things. It changes
   * nothing about this one being read-only: the gesture moves the viewport, and
   * there is no code path here that could move a block or touch a connection.
   */
  useWheelZoom(surface, setViewport, true, HOST_EXCLUSIONS);

  // Frame it once, when the workflow first appears.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fittedFor.current === workflow.id) return;
    fittedFor.current = workflow.id;
    fit();
  }, [workflow.id, fit]);

  /**
   * ⌘+ / ⌘− / ⌘0, zooming the diagram rather than the application.
   *
   * Never while a field has focus: `+` and `-` are ordinary characters, and a
   * shortcut that fired inside a text box would be a shortcut that ate them.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
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
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        fit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, fit]);

  const percent = Math.round(viewport.scale * 100);

  return (
    <div className="live-graph-surface" ref={surface}>
    <svg
      className={`live-graph${panning ? " is-panning" : ""}`}
      role="img"
      aria-label={`${workflow.name}, observed progress`}
      onPointerDown={(event) => {
        dragged.current = false;
        // Dragging the background pans. Nothing else here moves — the diagram
        // is a report, not an editor.
        if (event.target !== event.currentTarget) return;
        panFrom.current = { x: event.clientX, y: event.clientY, origin: viewport };
        setPanning(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const from = panFrom.current;
        if (!from) return;
        if (wasDrag(from, { x: event.clientX, y: event.clientY })) dragged.current = true;
        setViewport({
          scale: from.origin.scale,
          x: from.origin.x + (event.clientX - from.x),
          y: from.origin.y + (event.clientY - from.y),
        });
      }}
      onPointerUp={() => {
        panFrom.current = null;
        setPanning(false);
      }}
      /*
        Clicking away puts the step down.

        Selecting a step narrows the activity list beside the diagram, and the
        only way back out was the ✕ on that filter — a control you have to
        find, across the window from where you were looking. Clicking the
        diagram where there is nothing is the other thing people try, so it
        does what they mean.

        "Where there is nothing" is anything outside a block: the background,
        and a connection, which is not selectable here either. A click that
        landed on a block is that block's own business, and it has already
        toggled itself by the time this runs.
      */
      onClick={(event) => {
        if (!selectedBlockId || dragged.current) return;
        if ((event.target as Element).closest(".live-node")) return;
        onSelect(undefined);
      }}
    >
      <defs>
        <marker id="live-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#bab6b6" />
        </marker>
        <marker id="live-arrow-seen" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#2f8f5f" />
        </marker>
        <marker id="live-arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#56aee0" />
        </marker>
      </defs>

      <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
      {model.connected.map((path) => {
        const edge = workflow.edges.find((item) => item.id === path.output.id);
        const target = edge?.target ?? "";
        const tone = edgeTone(view, path.nodeId, target, boundaryKind, delivering);
        const style = EDGE_TONE[tone];
        return (
          <path
            key={`${path.nodeId}-${path.output.id}`}
            {...(edge ? { "data-edge": edge.id } : {})}
            className={`live-edge tone-${tone}`}
            d={path.geometry.path}
            fill="none"
            stroke={style.stroke}
            strokeWidth={style.width}
            {...(style.dash ? { strokeDasharray: style.dash } : {})}
            markerEnd={`url(#live-arrow${tone === "idle" ? "" : `-${tone}`})`}
          />
        );
      })}

      {workflow.nodes.map((node) => {
        const rect = blockRect(node);
        const structural = node.type === "start" || node.type === "end";
        const block = view.blocks[node.id];
        const state: DrawnRunState = structural
          ? boundaryState(view, node, sessionState)
          : (block?.state ?? "queued");
        const style = RUN_STATE[state];
        const selected = selectedBlockId === node.id;
        const passes = block?.passes ?? 0;

        return (
          <g
            key={node.id}
            className={`live-node state-${state}${selected ? " is-selected" : ""}${style.moves ? " moves" : ""}`}
            opacity={style.opacity}
            onClick={() => onSelect(selected ? undefined : node.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(selected ? undefined : node.id);
            }}
          >
            <title>{`${node.name} — ${style.label}${block?.note ? `. ${block.note}` : ""}`}</title>

            {/*
              One border, and it is the block's own.

              A live state used to be drawn as a second rounded rect six pixels
              outside the first, so an active block wore two outlines and sat
              heavier on the canvas than everything around it. The motion has
              moved onto the border that was already there: a block in a live
              state breathes rather than gaining a ring, which leaves its size,
              its ports and the edges landing on them exactly where they were.
            */}
            <rect
              className="live-node-body"
              x={rect.left}
              y={rect.top}
              width={rect.w}
              height={rect.h}
              rx={9}
              fill={style.fill}
              stroke={selected ? "#201e1d" : style.border}
              strokeWidth={selected ? 2.5 : style.borderWidth}
            />

            {!structural ? (
              /*
                Laid out by the browser, inside the card, rather than at three
                baselines this file works out itself.

                The name was cut at 24 characters, which is a guess at a width
                and was wrong for any alphabet whose letters are wider than the
                one it was tuned on: "Этап 2 — локальное пони…" is 24 characters
                and about 197 pixels in a box with room for 168, so it ran out
                through the right-hand border. It also dragged the group's
                bounding box with it, and the platform drew its focus ring
                around *that* — which is why the ring looked wider than the
                block it belonged to.

                CSS knows the width the glyphs actually take, so the ellipsis
                lands where the text truly stops fitting, and nothing can leave
                the card whatever anybody names a step.
              */
              <foreignObject
                x={rect.left + 1}
                y={rect.top + 1}
                width={rect.w - 2}
                height={rect.h - 2}
                className="live-node-text"
              >
                <div className="live-node-lines" style={{ color: style.ink }}>
                  <span className="live-node-kicker">{kicker(node)}</span>
                  <span className="live-node-name">{node.name}</span>
                  <span className="live-node-state">
                    {style.label}
                    {passes > 1 ? ` · pass ${passes}` : ""}
                    {/* How long the agent has been on this step — elapsed since
                        its own announcement, ticking, and plainly not a promise
                        about when it will finish. */}
                    {state === "running" && block?.enteredAt
                      ? ` · ${readDuration(now - Date.parse(block.enteredAt)) || "0s"} so far`
                      : ""}
                    {/* And what a finished step took, on the same footing: the
                        span from the agent announcing it to announcing the
                        next, summed over its passes. No "so far" — this one
                        has stopped. */}
                    {state === "done" && block?.spentMs !== undefined
                      ? ` · took ${readDuration(block.spentMs) || "0s"}`
                      : ""}
                  </span>
                </div>
              </foreignObject>
            ) : (
              <>
                <text
                  x={rect.left + rect.w / 2}
                  y={rect.top + rect.h / 2 + 4}
                  textAnchor="middle"
                  className="live-node-name"
                  fill={style.ink}
                >
                  {node.name}
                </text>
                {/* A boundary pill has no room for a state line inside it, and
                    these two states are the ones a reader would otherwise have
                    to infer from a colour. */}
                {state === "observing" || state === "unknown" ? (
                  <text
                    x={rect.left + rect.w / 2}
                    y={rect.top + rect.h + 18}
                    textAnchor="middle"
                    className="live-node-state"
                    fill={style.ink}
                  >
                    {style.label}
                  </text>
                ) : null}
              </>
            )}

            {state === "running" ? (
              // An indeterminate bar, never a percentage: Anthill is reading a
              // log, not measuring how far along the work is.
              <g clipPath="none">
                <rect
                  x={rect.left + 1}
                  y={rect.top + rect.h - 4}
                  width={rect.w - 2}
                  height={3}
                  rx={1.5}
                  fill="#e4f1fa"
                />
                <rect
                  className="live-slide"
                  x={rect.left + 1}
                  y={rect.top + rect.h - 4}
                  width={(rect.w - 2) * 0.34}
                  height={3}
                  rx={1.5}
                  fill="#56aee0"
                />
              </g>
            ) : null}
          </g>
        );
      })}
      </g>
    </svg>

      <div className="live-zoom" role="group" aria-label="Diagram zoom">
        <button
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={viewport.scale <= ZOOM_MIN + 0.001}
          aria-label="Zoom out"
          title="Zoom out (⌘−)"
        >
          −
        </button>
        <span data-testid="live-zoom-level" role="status" aria-live="polite">
          {percent}%
        </span>
        <button
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={viewport.scale >= ZOOM_MAX - 0.001}
          aria-label="Zoom in"
          title="Zoom in (⌘+)"
        >
          +
        </button>
        <button onClick={fit} title="Fit the whole workflow in view (⌘0)">
          Show whole workflow
        </button>
      </div>
    </div>
  );
}
