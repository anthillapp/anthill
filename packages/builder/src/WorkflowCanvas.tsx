/**
 * The workflow canvas.
 *
 * Written directly rather than on React Flow because the interactions the
 * design calls for are not the ones React Flow models: a connection starts by
 * clicking a port and finishes by clicking a *point* on the target block, and
 * that point is remembered as the anchor. React Flow connects handle to handle,
 * so its connection system, its edges and its selection would all have been
 * worked around rather than used.
 *
 * Everything positional lives in `workflow-canvas-model.ts` and `geometry.ts`; this
 * component renders and handles pointers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { ValidationResult, Workflow, WorkflowNode } from "@anthill/workflow-schema";
import {
  actionDefinition,
  agentConfig,
  agentForNode,
  outputsOf,
  patchOutput,
  removeOutput,
  setOutputTarget,
  type BlockOutput,
} from "@anthill/workflow";

import {
  anchorFromPoint,
  bendFromPoint,
  entryPoint,
  route,
  type Point,
} from "./geometry";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomAbout } from "./canvas-zoom";
import { useWheelZoom } from "./use-wheel-zoom";
import { centerOutputs, type CenterScope } from "./align";
import { moveNode, removeNode } from "./document";
import {
  GRID,
  OUTCOME_STYLES,
  blockColor,
  blockRect,
  buildCanvasModel,
  snapTarget,
  snapToGrid,
} from "./workflow-canvas-model";
import { assemblyPlan } from "./assembly";

/** What the canvas has selected: a block, or one block's output. */
export type WorkflowSelection =
  | { kind: "none" }
  | { kind: "block"; nodeId: string }
  | { kind: "output"; nodeId: string; outputId: string };

export const NO_SELECTION: WorkflowSelection = { kind: "none" };

/** An output waiting to be pointed at a block. */
export type LinkingState = { nodeId: string; outputId: string } | null;

/** Pan and zoom of the canvas. */
type View = { x: number; y: number; scale: number };

export type WorkflowCanvasProps = {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  validation?: ValidationResult;
  selection: WorkflowSelection;
  onSelectionChange: (selection: WorkflowSelection) => void;
  /**
   * Where a block click goes instead of selection, when something else owns it.
   *
   * The assistant panel replaces the inspector outright while it is open, so a
   * click has nothing to select *into*; it references the block in the request
   * being written instead. The callback's presence is the mode — there is no
   * separate boolean that could disagree with it — and the id is all that
   * travels, so a rename afterwards changes nothing about what was referenced.
   */
  onBlockPick?: (nodeId: string) => void;
  /** Controlled so the inspector can start linking too ("Re-route"). */
  linking: LinkingState;
  onLinkingChange: (linking: LinkingState) => void;
  /**
   * Set once, when a validated draft becomes the open workflow: the graph then
   * assembles in reading order — Start, blocks, connections last, each after
   * both its endpoints — instead of blinking into place. The geometry is final
   * from the first frame; only the timing of appearance is staged. Absent for
   * an opened or edited workflow, which draws at once.
   */
  assembling?: boolean;
  className?: string;
  style?: CSSProperties;
};

const CANVAS_BACKGROUND: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  background: "#f8f7f7",
  backgroundImage: "radial-gradient(rgba(32,30,29,0.13) 1px, transparent 1px)",
  backgroundSize: `${GRID}px ${GRID}px`,
};

function errorsFor(validation: ValidationResult | undefined, nodeId: string): number {
  return validation?.errors.filter((error) => error.nodeId === nodeId).length ?? 0;
}

function blockKicker(node: WorkflowNode): string {
  if (node.type === "start") return "Start";
  if (node.type === "end") return "End";
  if (node.type === "approval") return "Approval";
  const kind = agentConfig(node).actionKind;
  return kind ? actionDefinition(kind).label.toUpperCase() : "STEP";
}

/**
 * Keep the pointer on one element for the whole gesture, so a drag that leaves
 * the element still delivers its move and up events there.
 *
 * Guarded because jsdom does not implement pointer capture; without the guard
 * the component cannot be driven from a test.
 */
function capturePointer(element: Element | null | undefined, pointerId: number): void {
  element?.setPointerCapture?.(pointerId);
}

export function WorkflowCanvas({
  workflow,
  onChange,
  validation,
  selection,
  onSelectionChange,
  onBlockPick,
  linking,
  onLinkingChange,
  assembling,
  className,
  style,
}: WorkflowCanvasProps) {
  const surface = useRef<HTMLDivElement>(null);
  /** Where the dragged arrowhead is now, and what it is over. */
  const [pointer, setPointer] = useState<Point | null>(null);
  const [snapped, setSnapped] = useState<string | null>(null);
  const drag = useRef<{ nodeId: string; dx: number; dy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  /** True while an arrowhead is being dragged to a different block. */
  const draggingEnd = useRef(false);
  /**
   * A port being dragged around its block. `moved` separates the two gestures
   * a port answers to: press and drag moves it, press and release starts a
   * connection.
   */
  const portDrag = useRef<{
    nodeId: string;
    outputId: string;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  /** A line's bend handle being dragged. */
  const bendDrag = useRef<{ nodeId: string; outputId: string } | null>(null);
  /**
   * True for the click that ends a drag.
   *
   * A drag that starts on a handle and ends over empty canvas still fires one
   * `click`, on the nearest common ancestor — the surface — which would read as
   * "clicked the background" and clear the selection the author was working on.
   */
  const justDragged = useRef(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });

  const model = useMemo(() => buildCanvasModel(workflow), [workflow]);

  /**
   * The reveal plan, computed once per assembly and then left alone.
   *
   * Element delays come from the plan; the elements carry them as a CSS
   * variable, so the stylesheet owns the animation itself — which is also what
   * lets `prefers-reduced-motion` switch the whole reveal off in one rule and
   * simply show the finished graph.
   */
  const assembly = useMemo(
    () => (assembling ? assemblyPlan(workflow) : undefined),
    // Deliberately not keyed on `workflow`: the first edit mid-reveal would
    // otherwise restart the animation over the author's own change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assembling],
  );

  const appear = (delay: number | undefined): CSSProperties =>
    assembly !== undefined && delay !== undefined
      ? ({ "--assembly-delay": `${delay}s` } as CSSProperties)
      : {};

  /** Client coordinates to workflow coordinates, undoing the view transform. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number): Point => {
      const box = surface.current?.getBoundingClientRect();
      return {
        x: (clientX - (box?.left ?? 0) - view.x) / view.scale,
        y: (clientY - (box?.top ?? 0) - view.y) / view.scale,
      };
    },
    [view],
  );

  /** Frame the whole workflow, so nothing is stranded off-screen. */
  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    const rects = [...model.rects.values()];
    // A canvas measured at nothing — before layout, or while hidden — would
    // otherwise produce a negative scale and put the workflow inside out.
    if (!box || box.width <= 0 || box.height <= 0 || rects.length === 0) {
      setView({ x: 0, y: 0, scale: 1 });
      return;
    }
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.left + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.h));

    const margin = 60;
    const scale = Math.max(
      ZOOM_MIN,
      Math.min(
        1,
        ZOOM_MAX,
        (box.width - margin) / Math.max(1, right - left),
        (box.height - margin) / Math.max(1, bottom - top),
      ),
    );
    setView({
      scale,
      x: (box.width - (right - left) * scale) / 2 - left * scale,
      y: (box.height - (bottom - top) * scale) / 2 - top * scale,
    });
  }, [model.rects]);

  // Frame the workflow when it is first shown, so opening a template does not land
  // on a canvas showing only its left edge.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fittedFor.current === workflow.id) return;
    fittedFor.current = workflow.id;
    fit();
  }, [workflow.id, fit]);

  /**
   * What a connection leaving `sourceId` may be pointed at.
   *
   * A block cannot connect to itself — the path would have nowhere to go — and
   * nothing points at Start, which is where a workflow begins by definition.
   */
  const eligibleTarget = useCallback(
    (node: WorkflowNode, sourceId: string | undefined) =>
      node.id !== sourceId && node.type !== "start",
    [],
  );

  /** The block an arrowhead released here should attach to, if any. */
  const targetAt = useCallback(
    (point: Point, sourceId: string | undefined) =>
      snapTarget(point, workflow.nodes, (node) => eligibleTarget(node, sourceId)),
    [workflow.nodes, eligibleTarget],
  );

  /* ---------------- linking ---------------- */

  const startLinking = useCallback(
    (nodeId: string, outputId: string) => {
      onLinkingChange({ nodeId, outputId });
      onSelectionChange({ kind: "output", nodeId, outputId });
    },
    [onLinkingChange, onSelectionChange],
  );

  const finishLinking = useCallback(
    (targetId: string, at: Point) => {
      if (!linking) return;
      const target = workflow.nodes.find((node) => node.id === targetId);
      if (!target || !eligibleTarget(target, linking.nodeId)) {
        onLinkingChange(null);
        return;
      }

      onChange(
        setOutputTarget(
          workflow,
          linking.nodeId,
          linking.outputId,
          targetId,
          anchorFromPoint(blockRect(target), at),
        ),
      );
      onLinkingChange(null);
    },
    [linking, workflow, onChange, onLinkingChange, eligibleTarget],
  );

  // Nothing has been changed while dragging — the live arrow is a drawing, not
  // an edit — so letting go of the preview is all "restore the original" takes.
  useEffect(() => {
    if (linking) return;
    setPointer(null);
    setSnapped(null);
  }, [linking]);

  // Escape is the way out of linking; without it the only escape is connecting
  // something you did not mean to.
  useEffect(() => {
    if (!linking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onLinkingChange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linking, onLinkingChange]);

  /**
   * Delete removes whatever is selected.
   *
   * A block goes, and its connections with it. An arrow is detached first and
   * removed on a second press: pulling the port out from under the label, the
   * kind and the condition on the first press loses work the author may have
   * only wanted to re-route, so the first press takes back the routing and the
   * second takes the output itself.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const active = document.activeElement?.tagName;
      if (active === "INPUT" || active === "TEXTAREA" || active === "SELECT") return;

      if (selection.kind === "block") {
        if (!workflow.nodes.some((node) => node.id === selection.nodeId)) return;
        event.preventDefault();
        onChange(removeNode(workflow, selection.nodeId));
        onSelectionChange(NO_SELECTION);
        return;
      }

      if (selection.kind !== "output") return;
      const output = outputsOf(workflow, selection.nodeId).find(
        (item) => item.id === selection.outputId,
      );
      if (!output) return;

      event.preventDefault();
      if (output.target !== null) {
        onChange(setOutputTarget(workflow, selection.nodeId, selection.outputId, null));
        return;
      }
      onChange(removeOutput(workflow, selection.nodeId, selection.outputId));
      onSelectionChange(NO_SELECTION);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, workflow, onChange, onSelectionChange]);

  /* ---------------- tidying up ---------------- */

  /**
   * What the centre button will act on.
   *
   * Whole blocks, always: centring one port of a block without the others
   * sharing its side would stack them on top of each other.
   */
  const centerScope: CenterScope | undefined =
    selection.kind === "block"
      ? { kind: "block", nodeId: selection.nodeId }
      : selection.kind === "output"
        ? { kind: "output", nodeId: selection.nodeId, outputId: selection.outputId }
        : undefined;

  const centerLabel =
    selection.kind === "block"
      ? "Move every connection at this block to the middle of the side it meets"
      : selection.kind === "output"
        ? "Move this connection's ends to the middle of the sides they meet"
        : "Select an arrow or a block first";

  /* ---------------- dragging blocks ---------------- */

  const onBlockPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: WorkflowNode) => {
      if (linking) return;
      const at = toCanvas(event.clientX, event.clientY);
      const rect = blockRect(node);
      drag.current = { nodeId: node.id, dx: at.x - rect.left, dy: at.y - rect.top };
      capturePointer(event.currentTarget, event.pointerId);
    },
    [linking, toCanvas],
  );

  const onSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || linking) return;
      pan.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      capturePointer(event.currentTarget, event.pointerId);
    },
    [linking, view],
  );

  const onSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const panning = pan.current;
      if (panning) {
        setView((current) => ({
          ...current,
          x: panning.viewX + (event.clientX - panning.x),
          y: panning.viewY + (event.clientY - panning.y),
        }));
        return;
      }

      const at = toCanvas(event.clientX, event.clientY);
      if (linking) {
        setPointer(at);
        setSnapped(targetAt(at, linking.nodeId)?.node.id ?? null);
      }

      const port = portDrag.current;
      if (port) {
        // A few pixels of slop, so a slightly shaky click still connects
        // rather than nudging the port and doing nothing else.
        if (
          !port.moved &&
          Math.hypot(event.clientX - port.x, event.clientY - port.y) < 4
        ) {
          return;
        }
        port.moved = true;
        const owner = workflow.nodes.find((node) => node.id === port.nodeId);
        if (owner) {
          onChange(
            patchOutput(workflow, port.nodeId, port.outputId, {
              port: anchorFromPoint(blockRect(owner), at),
            }),
          );
        }
        return;
      }

      const bending = bendDrag.current;
      if (bending) {
        const path = model.connected.find(
          (item) => item.nodeId === bending.nodeId && item.output.id === bending.outputId,
        );
        if (path) {
          onChange(
            patchOutput(workflow, bending.nodeId, bending.outputId, {
              bend: bendFromPoint(
                path.port,
                path.geometry.to,
                path.output.routing ?? "curved",
                at,
              ),
            }),
          );
        }
        return;
      }

      const current = drag.current;
      if (!current) return;
      onChange(
        moveNode(workflow, current.nodeId, {
          x: snapToGrid(at.x - current.dx),
          y: snapToGrid(at.y - current.dy),
        }),
      );
    },
    [linking, toCanvas, workflow, onChange, model, targetAt],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
    pan.current = null;
    portDrag.current = null;
    bendDrag.current = null;
  }, []);

  /**
   * Releasing a dragged arrowhead drops it on whatever is underneath.
   *
   * Dropping on empty canvas leaves the arrow where it was rather than
   * detaching it — a slip of the mouse should not silently disconnect work.
   */
  const onSurfacePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // A port released without having moved was a click, and a click on a port
      // starts a connection.
      const port = portDrag.current;
      if (port && !port.moved) startLinking(port.nodeId, port.outputId);

      justDragged.current = Boolean(
        (port && port.moved) || bendDrag.current || draggingEnd.current || drag.current,
      );

      if (draggingEnd.current) {
        draggingEnd.current = false;
        const at = toCanvas(event.clientX, event.clientY);
        const hit = targetAt(at, linking?.nodeId);
        // The released point is the landing, projected onto whichever side of
        // the block it is nearest — so an arrow dropped below a block arrives
        // at its underside, not at some default corner.
        if (hit && linking) finishLinking(hit.node.id, at);
        else onLinkingChange(null);
      }
      endDrag();
    },
    [toCanvas, targetAt, linking, finishLinking, onLinkingChange, endDrag, startLinking],
  );

  /**
   * Zoom by a step, about the middle of the canvas.
   *
   * The buttons and the shortcuts go through the same `zoomAbout` the trackpad
   * uses, so a pinch and a press of `+` cannot end up meaning slightly
   * different things.
   */
  const zoomBy = useCallback((factor: number) => {
    const box = surface.current?.getBoundingClientRect();
    const focal = box ? { x: box.width / 2, y: box.height / 2 } : { x: 0, y: 0 };
    setView((current) => zoomAbout(current, factor, focal));
  }, []);

  // Pinch, and two-finger vertical movement, over the canvas only.
  useWheelZoom(surface, setView);

  /**
   * Command +/- zoom the workflow rather than the application.
   *
   * The browser's own zoom is the wrong thing here: it scales the inspector and
   * the block library along with the diagram, when what the author wants is to
   * see more of the workflow. Bound to the same limits as the buttons, so the two
   * cannot disagree.
   *
   * Left alone while typing: `+` and `-` are ordinary characters in a task
   * description, and a shortcut that fired inside a text field would be a
   * shortcut that ate them.
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

      // "=" is the unshifted key most keyboards put "+" on.
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        // The conventional partner of the other two.
        event.preventDefault();
        fit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, fit]);

  /* ---------------- rendering ---------------- */

  const linkingOutput: BlockOutput | undefined = linking
    ? outputsOf(workflow, linking.nodeId).find((output) => output.id === linking.outputId)
    : undefined;

  const linkingPath = linking
    ? [...model.connected, ...model.pending].find(
        (path) => path.nodeId === linking.nodeId && path.output.id === linking.outputId,
      )
    : undefined;
  const linkingPort = linkingPath?.port;

  /**
   * The connection being dragged, drawn where the pointer has it now.
   *
   * The real edge, not a phantom beside it: same colour, same dash, same
   * arrowhead, leaving the same port, and reshaping continuously. Over an
   * eligible block it lands on that block exactly as it would if released;
   * over open canvas it follows the pointer. Its ordinary rendering is
   * suppressed while this stands in, so there is never a moment with two of
   * them on screen.
   *
   * Nothing about the document changes until release, which is what makes
   * cancelling free: there is no edit to undo.
   */
  const liveEdge = (() => {
    if (!linking || !linkingPort || !pointer || !linkingOutput) return undefined;

    const target = snapped ? workflow.nodes.find((node) => node.id === snapped) : undefined;
    const landing = target
      ? entryPoint(blockRect(target), linkingPort, anchorFromPoint(blockRect(target), pointer))
      : {
          ...pointer,
          // A free end faces back the way the line came, so the curve arrives
          // at the pointer instead of hooking round it.
          side: pointer.x >= linkingPort.x ? ("left" as const) : ("right" as const),
        };

    return {
      geometry: route(linkingPort, landing, {
        routing: linkingOutput.routing,
        bend: linkingOutput.bend,
      }),
      style: OUTCOME_STYLES[linkingOutput.kind],
      kind: linkingOutput.kind,
      snapped: Boolean(target),
    };
  })();

  return (
    <div
      ref={surface}
      data-testid="workflow-canvas"
      className={className}
      // Dragging an arrow across the canvas would otherwise sweep a text
      // selection through every label it passes over.
      style={{ ...CANVAS_BACKGROUND, userSelect: "none", ...style }}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerUp={onSurfacePointerUp}
      onPointerLeave={endDrag}
      onClick={(event) => {
        if (justDragged.current) {
          justDragged.current = false;
          return;
        }
        if (event.target !== event.currentTarget) return;
        if (linking) onLinkingChange(null);
        else onSelectionChange(NO_SELECTION);
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: "0 0",
          pointerEvents: "none",
        }}
      >
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
      >
        <defs>
          {Object.entries(OUTCOME_STYLES).map(([kind, outcome]) => (
            <marker
              key={kind}
              id={`arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={outcome.color} />
            </marker>
          ))}
        </defs>

        {model.connected.map((path) => {
          const selected =
            selection.kind === "output" &&
            selection.nodeId === path.nodeId &&
            selection.outputId === path.output.id;
          // The live version below is standing in for this one.
          if (liveEdge && linking && linking.outputId === path.output.id) return null;
          return (
            <g
              key={`${path.nodeId}:${path.output.id}`}
              className={assembly ? "canvas-assemble" : undefined}
              // A connected output's id is its edge's id — `edgeToOutput` keeps
              // them the same — so the plan's edge delays apply directly.
              style={appear(assembly?.edges.get(path.output.id))}
            >
              {/* A wide invisible path so the thin line is easy to hit. */}
              <path
                d={path.geometry.path}
                stroke="transparent"
                strokeWidth={20}
                fill="none"
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onClick={() =>
                  onSelectionChange({
                    kind: "output",
                    nodeId: path.nodeId,
                    outputId: path.output.id,
                  })
                }
              />
              <path
                d={path.geometry.path}
                stroke={path.style.color}
                strokeWidth={selected ? 3 : path.style.width}
                strokeDasharray={path.style.dash}
                fill="none"
                markerEnd={`url(#arrow-${path.output.kind})`}
                style={{ pointerEvents: "none" }}
              />
            </g>
          );
        })}

        {model.pending.map((path) => (
          liveEdge && linking?.outputId === path.output.id ? null :
          <path
            key={`${path.nodeId}:${path.output.id}`}
            d={path.path}
            stroke={path.style.color}
            strokeWidth={path.style.width}
            strokeDasharray="5 5"
            fill="none"
            style={{ pointerEvents: "none" }}
          />
        ))}

        {liveEdge ? (
          <path
            data-testid="live-edge"
            d={liveEdge.geometry.path}
            stroke={liveEdge.style.color}
            strokeWidth={liveEdge.snapped ? 3 : liveEdge.style.width}
            strokeDasharray={liveEdge.style.dash}
            fill="none"
            markerEnd={`url(#arrow-${liveEdge.kind})`}
            style={{ pointerEvents: "none" }}
          />
        ) : null}
      </svg>

      {/* Labels sit above the lines but below the cards. */}
      {model.connected.map((path) => {
        const selected =
          selection.kind === "output" &&
          selection.nodeId === path.nodeId &&
          selection.outputId === path.output.id;
        const quiet = path.output.kind === "next" && !path.output.condition;
        if (!path.output.label && !path.output.condition) return null;

        return (
          <div
            key={`label-${path.nodeId}:${path.output.id}`}
            data-testid={`edge-label-${path.output.id}`}
            onClick={() =>
              onSelectionChange({
                kind: "output",
                nodeId: path.nodeId,
                outputId: path.output.id,
              })
            }
            style={{
              pointerEvents: "auto",
              position: "absolute",
              left: path.label.x,
              top: path.label.y,
              transform: "translate(-50%, -50%)",
              padding: quiet ? "1px 4px" : "4px 8px",
              borderRadius: 7,
              background: quiet ? "rgba(248,247,247,0.92)" : "#ffffff",
              border: quiet ? "none" : `1px solid ${selected ? path.style.color : "#e2dfdf"}`,
              boxShadow: selected ? `0 2px 10px ${path.style.color}33` : undefined,
              fontSize: quiet ? 11 : 12,
              fontWeight: quiet ? 400 : 600,
              color: quiet ? "#8a8584" : "#201e1d",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {path.output.label}
            {path.output.condition ? (
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 10.5,
                  fontWeight: 400,
                  color: "#7d7979",
                }}
              >
                {path.output.condition}
              </div>
            ) : null}
          </div>
        );
      })}

      {model.pending.map((path) => (
        <div
          key={`stub-${path.nodeId}:${path.output.id}`}
          onClick={() => startLinking(path.nodeId, path.output.id)}
          style={{
            pointerEvents: "auto",
            position: "absolute",
            left: path.label.x,
            top: path.label.y,
            transform: "translate(-50%, -50%)",
            padding: "2px 7px",
            borderRadius: 7,
            border: `1px dashed ${path.style.color}`,
            background: "#ffffff",
            fontSize: 11.5,
            color: path.style.color,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {path.output.label || "not connected"}
        </div>
      ))}

      {/* Blocks */}
      {workflow.nodes.map((node) => {
        const rect = blockRect(node);
        const color = blockColor(node);
        const isPill = node.type === "start" || node.type === "end";
        const selected = selection.kind === "block" && selection.nodeId === node.id;
        const problems = errorsFor(validation, node.id);
        // Within the snap area of the arrowhead being dragged: say so before
        // the author lets go, not after.
        const isTarget = snapped === node.id;
        const config = node.type === "agent" ? agentConfig(node) : undefined;
        const agent = node.type === "agent" ? agentForNode(workflow, node.id) : undefined;

        return (
          <div
            key={node.id}
            className={assembly ? "canvas-assemble" : undefined}
            data-testid={`workflow-block-${node.id}`}
            data-snap-target={isTarget ? "true" : undefined}
            onPointerDown={(event) => onBlockPointerDown(event, node)}
            onClick={(event) => {
              event.stopPropagation();
              if (linking) finishLinking(node.id, toCanvas(event.clientX, event.clientY));
              else if (onBlockPick) onBlockPick(node.id);
              else onSelectionChange({ kind: "block", nodeId: node.id });
            }}
            style={{
              pointerEvents: "auto",
              position: "absolute",
              left: rect.left,
              top: rect.top,
              width: rect.w,
              height: rect.h,
              boxSizing: "border-box",
              background: "#ffffff",
              border:
                isTarget || selected ? `2px solid ${color}` : "1px solid #d7d3d3",
              borderRadius: isPill ? 999 : 10,
              boxShadow: isTarget
                ? `0 0 0 5px ${color}33, 0 8px 22px ${color}3d`
                : selected
                  ? `0 0 0 3px ${color}22, 0 6px 18px ${color}2e`
                  : "0 1px 2px rgba(32,30,29,0.10)",
              padding: isPill ? "0 16px" : "11px 13px",
              display: "flex",
              flexDirection: isPill ? "row" : "column",
              alignItems: isPill ? "center" : "stretch",
              gap: isPill ? 8 : 4,
              cursor: linking ? "crosshair" : "grab",
              userSelect: "none",
              ...appear(assembly?.blocks.get(node.id)),
            }}
          >
            {isPill ? (
              <>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: node.type === "start" ? color : "transparent",
                    border: node.type === "start" ? "none" : `1.5px solid ${color}`,
                    flex: "none",
                  }}
                />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: "#201e1d" }}>
                  {node.name}
                </span>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{ width: 7, height: 7, borderRadius: 2, background: color, flex: "none" }}
                  />
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: "0.12em",
                      color: "#8a8584",
                      textTransform: "uppercase",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {blockKicker(node)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    letterSpacing: "-0.015em",
                    color: "#201e1d",
                    lineHeight: 1.2,
                    overflow: "hidden",
                  }}
                >
                  {node.name}
                </div>
                <div style={{ marginTop: "auto", display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {agent ? <Chip>{agent.name || "Unnamed agent"}</Chip> : null}
                  {config?.maxIterations ? <Chip>{`×${config.maxIterations}`}</Chip> : null}
                  {problems > 0 ? (
                    <Chip tone="problem">
                      {problems} {problems === 1 ? "problem" : "problems"}
                    </Chip>
                  ) : null}
                </div>
              </>
            )}
          </div>
        );
      })}

      {/* The grab handle on a selected arrow's head. Drawn above the cards so
          it can be picked up even where it overlaps one. */}
      {model.connected.map((path) => {
        const selected =
          selection.kind === "output" &&
          selection.nodeId === path.nodeId &&
          selection.outputId === path.output.id;
        if (!selected) return null;

        return (
          <div
            key={`end-${path.nodeId}:${path.output.id}`}
            data-testid={`arrow-handle-${path.output.id}`}
            title="Drag onto another block to re-route"
            onPointerDown={(event) => {
              event.stopPropagation();
              draggingEnd.current = true;
              setPointer(path.geometry.to);
              onLinkingChange({ nodeId: path.nodeId, outputId: path.output.id });
              capturePointer(surface.current, event.pointerId);
            }}
            style={{
              pointerEvents: "auto",
              position: "absolute",
              left: path.geometry.to.x - 7,
              top: path.geometry.to.y - 7,
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#ffffff",
              border: `2.5px solid ${path.style.color}`,
              cursor: "grab",
              zIndex: 7,
              transition: "transform 120ms",
            }}
          />
        );
      })}

      {/* The bend handle at the middle of a selected line. Dragging it reshapes
          the line; double-clicking puts it back to its default shape. */}
      {model.connected.map((path) => {
        const selected =
          selection.kind === "output" &&
          selection.nodeId === path.nodeId &&
          selection.outputId === path.output.id;
        if (!selected) return null;

        return (
          <div
            key={`bend-${path.nodeId}:${path.output.id}`}
            data-testid={`bend-handle-${path.output.id}`}
            title="Drag to bend the line · Double-click to straighten it"
            onPointerDown={(event) => {
              event.stopPropagation();
              bendDrag.current = { nodeId: path.nodeId, outputId: path.output.id };
              capturePointer(surface.current, event.pointerId);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onChange(
                patchOutput(workflow, path.nodeId, path.output.id, { bend: null }),
              );
            }}
            style={{
              pointerEvents: "auto",
              position: "absolute",
              left: path.geometry.mid.x - 6,
              top: path.geometry.mid.y - 6,
              width: 12,
              height: 12,
              borderRadius: 3,
              transform: "rotate(45deg)",
              background: "#ffffff",
              border: `2px solid ${path.style.color}`,
              boxShadow: "0 1px 3px rgba(32,30,29,0.25)",
              cursor: "grab",
              zIndex: 8,
            }}
          />
        );
      })}

      {/* Ports, drawn above the cards so they stay clickable. */}
      {[...model.connected, ...model.pending].map((path) => {
        const active = linking?.nodeId === path.nodeId && linking.outputId === path.output.id;
        return (
          <div
            key={`port-${path.nodeId}:${path.output.id}`}
            data-testid={`port-${path.output.id}`}
            title="Drag to move it around the block · Click to connect"
            onPointerDown={(event) => {
              event.stopPropagation();
              // While linking, a port is a target to switch to, not something
              // to move.
              if (linking) {
                startLinking(path.nodeId, path.output.id);
                return;
              }
              portDrag.current = {
                nodeId: path.nodeId,
                outputId: path.output.id,
                x: event.clientX,
                y: event.clientY,
                moved: false,
              };
              capturePointer(surface.current, event.pointerId);
            }}
            style={{
              pointerEvents: "auto",
              position: "absolute",
              left: path.port.x - 6,
              top: path.port.y - 6,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: path.output.target === null || active ? path.style.color : "#ffffff",
              border: `2px solid ${path.style.color}`,
              boxShadow: active
                ? `0 0 0 6px ${path.style.color}33`
                : "0 0 0 2px #f8f7f7",
              cursor: linking ? "crosshair" : "grab",
              transition: "transform 120ms",
            }}
          />
        );
      })}

      </div>

      <div className="zoom-group">
        <button
          onClick={() => zoomBy(1 / 1.15)}
          title="Zoom out (⌘−)"
          aria-label="Zoom out"
        >
          −
        </button>
        <span data-testid="zoom-level" role="status" aria-live="polite">
          {Math.round(view.scale * 100)}%
        </span>
        <button onClick={() => zoomBy(1.15)} title="Zoom in (⌘+)" aria-label="Zoom in">
          +
        </button>
        <button onClick={fit} title="Fit the whole workflow on screen (⌘0)">
          Show whole workflow
        </button>
        <button
          data-testid="center-outputs"
          disabled={!centerScope}
          title={centerLabel}
          onClick={() => centerScope && onChange(centerOutputs(workflow, centerScope))}
        >
          Center connection on block
        </button>
      </div>

      {linking ? (
        <div
          data-testid="linking-hint"
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#2d2b2b",
            color: "#f8f4f4",
            padding: "7px 12px",
            borderRadius: 999,
            fontSize: 12,
            boxShadow: "0 6px 18px rgba(32,30,29,0.24)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            pointerEvents: "none",
          }}
        >
          Point at the block “{linkingOutput?.label || linkingOutput?.kind || "this output"}” leads to
          <span
            style={{
              border: "1px solid rgba(255,255,255,0.3)",
              borderRadius: 5,
              padding: "1px 5px",
              fontSize: 11,
            }}
          >
            Esc
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "problem";
}) {
  return (
    <span
      style={{
        fontSize: 10.5,
        padding: "1px 6px",
        borderRadius: 999,
        background: tone === "problem" ? "#fff2ef" : "#f3f2f2",
        color: tone === "problem" ? "#ae1800" : "#605d5d",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export default WorkflowCanvas;
