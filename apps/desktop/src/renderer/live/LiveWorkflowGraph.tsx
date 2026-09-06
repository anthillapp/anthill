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
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  blockRect,
  buildCanvasModel,
  useWheelZoom,
  zoomAbout,
  type Workflow,
} from "@anthill/builder";
import { agentConfig } from "@anthill/workflow";
import { hasStepEvidence, type LiveSessionState, type LiveSessionView } from "@anthill/live";
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
  return Object.values(view.blocks).every((block) => block.state === "done") && !view.empty
    ? "done"
    : "queued";
}

/**
 * How an edge is drawn, from the states at its two ends.
 *
 * Only the edge that actually delivered control flows. A workflow with a rework
 * loop has two edges arriving at the same step, and drawing both as live would
 * claim the work came back round when it never did — so an edge is live only
 * when its own source has been left behind.
 *
 * A start block has no observed state of its own; it counts as passed as soon
 * as anything at all has been observed, which is what "the session began" means.
 */
function edgeTone(
  view: LiveSessionView,
  source: string,
  target: string,
  isBoundary: (id: string) => boolean,
): EdgeTone {
  const from = view.blocks[source];
  const to = view.blocks[target];
  const left = isBoundary(source) ? !view.empty : from?.state === "done";
  if (!left) return "idle";
  return to && (to.state === "running" || to.state === "needsYou") ? "live" : "seen";
}

export function LiveWorkflowGraph({
  workflow,
  view,
  sessionState,
  selectedBlockId,
  onSelect,
}: LiveWorkflowGraphProps) {
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

  const isBoundary = useMemo(() => {
    const ids = new Set(
      workflow.nodes.filter((node) => node.type === "start" || node.type === "end").map((n) => n.id),
    );
    return (id: string) => ids.has(id);
  }, [workflow]);

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
  useWheelZoom(surface, setViewport);

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
        const tone = edgeTone(view, path.nodeId, target, isBoundary);
        const style = EDGE_TONE[tone];
        return (
          <path
            key={`${path.nodeId}-${path.output.id}`}
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
              <>
                <text x={rect.left + 14} y={rect.top + 23} className="live-node-kicker" fill={style.ink}>
                  {kicker(node)}
                </text>
                <text x={rect.left + 14} y={rect.top + 45} className="live-node-name" fill={style.ink}>
                  {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
                </text>
                <text x={rect.left + 14} y={rect.top + 70} className="live-node-state" fill={style.ink}>
                  {style.label}
                  {passes > 1 ? ` · pass ${passes}` : ""}
                  {/* How long the agent has been on this step — elapsed since
                      its own announcement, ticking, and plainly not a promise
                      about when it will finish. */}
                  {state === "running" && block?.enteredAt
                    ? ` · ${readDuration(now - Date.parse(block.enteredAt)) || "0s"} so far`
                    : ""}
                </text>
              </>
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
