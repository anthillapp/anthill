/**
 * The canvas's view of a workflow: block boxes, ports, and the paths between them.
 *
 * Pure — it turns a `Workflow` into everything the canvas needs to draw, so the
 * component itself only has to render and handle pointers. That also makes the
 * layout decisions testable, which the rendering is not.
 */

import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";
import {
  agentConfig,
  actionDefinition,
  outputsOf,
  type ActionCategory,
  type BlockOutput,
} from "@anthill/workflow";

import {
  entryPoint,
  labelHalfSize,
  labelSpot,
  loopBelow,
  passesUnder,
  portFromAnchor,
  portPoint,
  portSideToward,
  route,
  unconnectedStub,
  type CurveGeometry,
  type Point,
  type PortPoint,
  type Rect,
} from "./geometry";

/** Half the size of the bend handle drawn at the middle of a selected line. */
const HANDLE_HALF = 9;

/** Step cards and control pills are different sizes. */
export const STEP_SIZE = { w: 196, h: 100 };
/** The smallest a control pill gets — what "Start", "End" and "Done" need. */
export const PILL_SIZE = { w: 108, h: 40 };

/**
 * How large a control pill may grow before its name is cut instead.
 *
 * A pill is a label, not a paragraph. Past this the name is truncated and the
 * whole of it is available on hover, which is better than a terminal block
 * wider than the steps around it.
 */
export const PILL_MAX = { w: 242, h: PILL_SIZE.h + 20 };

/**
 * What the pill spends on everything that is not the name: 16px of padding on
 * each side, the 9px status dot, and the 8px gap after it. Kept here because
 * the width below is only as right as this is — `WorkflowCanvas` lays the pill
 * out with exactly these numbers.
 */
const PILL_CHROME = 16 + 9 + 8 + 16;

/**
 * Roughly how wide one character of the pill's label is.
 *
 * The label is 13.5px at weight 600. This is an estimate and deliberately so:
 * `blockSize` is called during layout and from tests that run without a real
 * text renderer — jsdom reports nothing useful for `measureText` — so a
 * measured width would be either unavailable or wrong exactly where the
 * geometry is checked. An estimate that is a little generous costs a few
 * pixels of padding; one that is short cuts the name (ANT-113).
 */
const PILL_CHAR = 7.6;

/**
 * The size a control pill needs for its name: wider first, then taller.
 *
 * Start and End take whatever name the author gives them, and the shape never
 * followed. "Ready for the PR" wrapped to three cramped lines inside 108×40.
 */
function pillSize(name: string): { w: number; h: number } {
  const wanted = PILL_CHROME + name.trim().length * PILL_CHAR;
  if (wanted <= PILL_SIZE.w) return PILL_SIZE;

  const w = Math.min(snapToGrid(Math.ceil(wanted)), PILL_MAX.w);
  // A name too long even at full width gets a second line rather than a
  // smaller font — and past two lines it is truncated, which is the renderer's
  // business and not this function's.
  const h = wanted > PILL_MAX.w ? PILL_MAX.h : PILL_SIZE.h;
  return { w, h };
}

/** Colour per block category. Meaning, not decoration — red is reserved. */
export const CATEGORY_COLORS: Record<ActionCategory | "control" | "approval" | "end", string> = {
  understand: "#56aee0",
  build: "#6b5bd2",
  verify: "#d8a21a",
  deliver: "#2f8f5f",
  control: "#605d5d",
  approval: "#ec3013",
  end: "#bab6b6",
};

/** Amber on white reads badly, so verify labels use a darker ink. */
export const CATEGORY_INK: Partial<Record<string, string>> = { verify: "#8a6a08" };

export type OutcomeStyle = {
  color: string;
  dash?: string;
  width: number;
};

export const OUTCOME_STYLES: Record<BlockOutput["kind"], OutcomeStyle> = {
  next: { color: "#7d7979", width: 1.75 },
  rework: { color: "#d8a21a", dash: "7 5", width: 1.75 },
  question: { color: "#56aee0", dash: "2 5", width: 2 },
  stop: { color: "#ec3013", dash: "7 5", width: 1.75 },
};

export function blockSize(node: WorkflowNode): { w: number; h: number } {
  // One answer, because this is not only about drawing: layout, the canvas
  // extent, edge anchoring and hit-testing all read it, and a pill that
  // reports one size and draws another puts the arrows in the wrong place.
  return node.type === "start" || node.type === "end" ? pillSize(node.name) : STEP_SIZE;
}

export function blockRect(node: WorkflowNode): Rect {
  const size = blockSize(node);
  return {
    left: node.position?.x ?? 0,
    top: node.position?.y ?? 0,
    w: size.w,
    h: size.h,
  };
}

/** Which colour a block is drawn in. */
export function blockColor(node: WorkflowNode): string {
  if (node.type === "start") return CATEGORY_COLORS.control;
  if (node.type === "end") return CATEGORY_COLORS.end;
  if (node.type === "approval") return CATEGORY_COLORS.approval;

  const kind = agentConfig(node).actionKind;
  if (!kind) return CATEGORY_COLORS.control;
  return CATEGORY_COLORS[actionDefinition(kind).category];
}

export type ConnectedPath = {
  nodeId: string;
  output: BlockOutput;
  /** Index among the block's outputs, which decides the port position. */
  index: number;
  geometry: CurveGeometry;
  label: Point;
  style: OutcomeStyle;
  port: PortPoint;
};

export type PendingPath = {
  nodeId: string;
  output: BlockOutput;
  index: number;
  port: PortPoint;
  /** Straight stub drawn where the arrow would go once it is routed. */
  path: string;
  label: Point;
  style: OutcomeStyle;
};

export type CanvasModel = {
  rects: Map<string, Rect>;
  connected: ConnectedPath[];
  pending: PendingPath[];
};

/**
 * Work out every port, path and label position for a workflow.
 *
 * Labels are placed last and against every block, so a label pushed off one
 * curve does not land on a card belonging to another.
 */
/** How far under its row a loop back along the row runs, and how much deeper for each loop it spans. */
const LOOP_DEPTH = 30;
const LOOP_STEP = 22;

export function buildCanvasModel(workflow: Workflow): CanvasModel {
  const rects = new Map<string, Rect>();
  for (const node of workflow.nodes) rects.set(node.id, blockRect(node));

  const blocks = [...rects.values()];
  const connected: ConnectedPath[] = [];
  /*
    Labels already placed, which the next one keeps clear of as it does of a
    block. Placed one by one with no idea of each other, two connections
    leaving and entering the same side of a step put "re-run" under "tests
    failed" (ANT-194).
  */
  const placed: Rect[] = [];
  const pending: PendingPath[] = [];

  /*
    A loop back to a step earlier in the same row, with nothing placed by
    hand, leaves the bottom of its step and arrives at the bottom of the step
    it returns to. Landed on that step's left side, as any connection from the
    same row is, it could only get there straight through the step — along
    the forward line and behind the card, where it read as nothing (ANT-196).
    Under the row is where the templates' own loops say they go (ANT-194).
    Several loops leaving or arriving at one step are spread along its
    bottom, nearest source innermost, so they nest rather than cross.
  */
  const sameRow = (a: Rect, b: Rect) => a.top < b.top + b.h && b.top < a.top + a.h;
  const loopsUnder = new Map<string, { leave: number; arrive: number; depth: number }>();
  {
    const loops: { key: string; source: string; target: string; reach: number; left: number; right: number; row: Rect }[] = [];
    for (const node of workflow.nodes) {
      const rect = rects.get(node.id);
      if (!rect) continue;
      for (const output of outputsOf(workflow, node.id)) {
        if (output.target === null || output.port || output.anchor) continue;
        const targetRect = rects.get(output.target);
        if (!targetRect || !sameRow(rect, targetRect)) continue;
        if (portSideToward(rect, targetRect) !== "left") continue;
        loops.push({
          key: `${node.id}:${output.id}`,
          source: node.id,
          target: output.target,
          reach: rect.left - targetRect.left,
          left: targetRect.left,
          right: rect.left + rect.w,
          row: rect,
        });
      }
    }
    const spread = (group: typeof loops, from: number, sign: 1 | -1, field: "leave" | "arrive") => {
      const ordered = [...group].sort((a, b) => a.reach - b.reach);
      ordered.forEach((loop, index) => {
        const at = from + sign * 0.3 * ((index + 1) / (ordered.length + 1) - 0.5);
        const current = loopsUnder.get(loop.key) ?? { leave: 0.65, arrive: 0.35, depth: LOOP_DEPTH };
        loopsUnder.set(loop.key, { ...current, [field]: at });
      });
    };
    for (const id of new Set(loops.map((loop) => loop.source))) {
      spread(loops.filter((loop) => loop.source === id), 0.65, -1, "leave");
    }
    for (const id of new Set(loops.map((loop) => loop.target))) {
      spread(loops.filter((loop) => loop.target === id), 0.35, -1, "arrive");
    }
    // Deeper for every loop in the same row it spans, so the outer one runs
    // under the inner one instead of across it.
    for (const loop of loops) {
      const inside = loops.filter(
        (other) =>
          other !== loop &&
          sameRow(other.row, loop.row) &&
          other.left >= loop.left &&
          other.right <= loop.right &&
          other.reach < loop.reach,
      ).length;
      const current = loopsUnder.get(loop.key) ?? { leave: 0.65, arrive: 0.35, depth: LOOP_DEPTH };
      loopsUnder.set(loop.key, { ...current, depth: LOOP_DEPTH + inside * LOOP_STEP });
    }
  }

  for (const node of workflow.nodes) {
    const outputs = outputsOf(workflow, node.id);
    const rect = rects.get(node.id);
    if (!rect) continue;

    // Ports the author has placed are fixed; the rest are spread along the
    // edge they leave from, among the others leaving that same edge — so
    // moving one does not shuffle the others, and a block with two forward
    // outputs and one rework output shows two ports on the right and one on
    // the left rather than three on the right.
    const under = (output: (typeof outputs)[number]) => loopsUnder.get(`${node.id}:${output.id}`);
    const automatic = outputs.filter((output) => !output.port && !under(output));
    const sideOf = new Map<(typeof outputs)[number], "left" | "right">();
    for (const output of automatic) {
      const targetRect = output.target === null ? undefined : rects.get(output.target);
      // An output with nowhere to go leaves forwards: there is no target to
      // read a direction from, and forwards is what it will most likely become.
      sideOf.set(output, targetRect ? (portSideToward(rect, targetRect) as "left" | "right") : "right");
    }

    outputs.forEach((output, index) => {
      const side = sideOf.get(output) ?? "right";
      const sharing = automatic.filter((item) => sideOf.get(item) === side);
      const loop = under(output);
      const port = output.port
        ? portFromAnchor(rect, output.port)
        : loop
          ? portFromAnchor(rect, { u: loop.leave, v: 1 })
          : portPoint(rect, sharing.indexOf(output), sharing.length, side);
      const style = OUTCOME_STYLES[output.kind];

      if (output.target === null) {
        const stub = unconnectedStub(port);
        pending.push({
          nodeId: node.id,
          output,
          index,
          port,
          path: stub.path,
          label: stub.label,
          style,
        });
        return;
      }

      const targetRect = rects.get(output.target);
      if (!targetRect) return;

      const options = {
        routing: output.routing,
        bend: output.bend,
        // What the line has to get past. Without this the router has no idea
        // anything is in the way, and a connection reaching past several
        // blocks is drawn straight through them.
        blocks,
      };
      let landing = entryPoint(targetRect, port, output.anchor ?? (loop ? { u: loop.arrive, v: 1 } : undefined));
      let geometry = route(port, landing, options);
      if (loop && !output.bend) {
        const below = loopBelow(port, landing, loop.depth, output.routing ?? "curved");
        // Unless something sits under the row in the way; then the router's
        // own way round stands.
        if (!passesUnder(port, landing, below, blocks)) geometry = below;
      }
      /*
        A step stacked under a sibling is entered from above by default, and
        the line down to it then runs behind the sibling in between: a fork's
        third branch was drawn through its second (ANT-178). Its left side,
        facing the step the line comes from, is the way in when the top is
        blocked. Only when nobody placed the landing or shaped the line.
      */
      if (
        !output.anchor &&
        !output.bend &&
        (landing.side === "top" || landing.side === "bottom") &&
        port.x < targetRect.left &&
        passesUnder(port, landing, geometry, blocks)
      ) {
        const side = entryPoint(targetRect, port, { u: 0, v: (port.y - targetRect.top) / targetRect.h });
        const beside = route(port, side, options);
        if (!passesUnder(port, side, beside, blocks)) {
          landing = side;
          geometry = beside;
        }
      }
      const { halfW, halfH } = labelHalfSize(output.label || " ", {
        quiet: output.kind === "next" && !output.condition,
        hasCondition: Boolean(output.condition),
        ...(output.condition ? { condition: output.condition } : {}),
      });

      // The bend handle sits at the middle of the line, which is also where a
      // label would like to be. Treat it as something to keep clear of, so the
      // handle stays grabbable and the label does not shift when selected.
      const handleSpot: Rect = {
        left: geometry.mid.x - HANDLE_HALF,
        top: geometry.mid.y - HANDLE_HALF,
        w: HANDLE_HALF * 2,
        h: HANDLE_HALF * 2,
      };

      const label = labelSpot(geometry, halfW, halfH, [...blocks, handleSpot, ...placed]);
      placed.push({ left: label.x - halfW, top: label.y - halfH, w: halfW * 2, h: halfH * 2 });

      connected.push({
        nodeId: node.id,
        output,
        index,
        geometry,
        label,
        style,
        port,
      });
    });
  }

  return { rects, connected, pending };
}

/**
 * How far outside a block still counts as aiming at it.
 *
 * Generous enough that an arrowhead released near a block lands on it —
 * dropping a connection is a gesture, not a click on a 196-pixel rectangle —
 * and well short of the 132-pixel gap the generated layout leaves between
 * columns, so two neighbours never both claim the same release point.
 */
export const SNAP_RADIUS = 48;

/** How far a point is from a rectangle. Zero when it is inside. */
export function distanceToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - (rect.left + rect.w));
  const dy = Math.max(rect.top - point.y, 0, point.y - (rect.top + rect.h));
  return Math.hypot(dx, dy);
}

export type SnapCandidate = { node: WorkflowNode; rect: Rect; distance: number };

/**
 * The block an arrowhead released here should connect to.
 *
 * Nearest wins rather than first-found, so releasing between two blocks picks
 * the one actually being aimed at instead of whichever happens to be drawn on
 * top. `eligible` decides what may be connected to at all, and a point outside
 * every eligible block's reach comes back undefined — a release in open space
 * must not be quietly attached to something.
 */
export function snapTarget(
  point: Point,
  nodes: readonly WorkflowNode[],
  eligible: (node: WorkflowNode) => boolean,
  radius = SNAP_RADIUS,
): SnapCandidate | undefined {
  let best: SnapCandidate | undefined;
  for (const node of nodes) {
    if (!eligible(node)) continue;
    const rect = blockRect(node);
    const distance = distanceToRect(point, rect);
    if (distance > radius) continue;
    if (!best || distance < best.distance) best = { node, rect, distance };
  }
  return best;
}

/** Snap a dropped position to the dot grid the canvas draws. */
export const GRID = 22;

export function snapToGrid(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * Where a block dropped at `point` should sit.
 *
 * The cursor holds the middle of the card, and the result is kept inside the
 * canvas so a block cannot be dropped where it cannot be seen.
 */
export function dropPosition(
  point: Point,
  canvas: { width: number; height: number },
): Point {
  const x = point.x - STEP_SIZE.w / 2;
  const y = point.y - STEP_SIZE.h / 2;
  return {
    x: snapToGrid(Math.min(Math.max(x, 12), Math.max(12, canvas.width - STEP_SIZE.w - 12))),
    y: snapToGrid(Math.min(Math.max(y, 56), Math.max(56, canvas.height - STEP_SIZE.h - 12))),
  };
}
