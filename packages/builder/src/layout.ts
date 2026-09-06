/**
 * Laying out a generated workflow.
 *
 * A workflow that arrives from a draft has no positions — the interpreter proposed
 * a shape, not a picture. This turns that shape into one: a left-to-right
 * layered drawing where the main path reads as a line and the loops read as
 * arcs back over it.
 *
 * Layered in the usual three passes: break the cycles, put every block in a
 * column, then order the blocks within each column so the lines between them
 * cross as little as they reasonably can. The ordering pass is a barycentre
 * sweep, which is a heuristic — it reduces crossings, it does not eliminate
 * them, and on a dense cyclic graph it will leave some. That is the honest
 * claim, and the fallback for a graph it cannot lay out well is still a
 * readable grid rather than a pile.
 *
 * Only ever used to place a workflow that has no layout of its own. Nothing here
 * runs again after the author has moved a block: a generated layout that
 * reasserted itself over someone's arrangement would be a bug, not a feature.
 */

import type {
  EdgeAnchorPoint,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "@anthill/workflow-schema";
import {
  bendFromPoint,
  entryPoint,
  portFromAnchor,
  type Bend,
  type Point,
  type Rect,
} from "./geometry";
import { GRID, blockRect, blockSize, snapToGrid } from "./workflow-canvas-model";

export type LayoutOptions = {
  /** Space between columns. Wide enough for a label to sit on the line. */
  columnGap?: number;
  /** Space between blocks in a column. Wide enough for a block's ports. */
  rowGap?: number;
  origin?: Point;
  /** Barycentre sweeps. More is tidier and slower; four is past the knee. */
  sweeps?: number;
};

const DEFAULTS = {
  columnGap: 132,
  rowGap: 66,
  origin: { x: 40, y: 40 },
  sweeps: 4,
};

type Link = { from: string; to: string };

/* ------------------------------------------------------------------ */
/* 1. Cycles                                                           */
/* ------------------------------------------------------------------ */

/**
 * Split the edges into the ones that go forward and the ones that come back.
 *
 * A depth-first walk from the workflow's entry points: an edge that lands on a
 * block already on the current path is a back edge. Removing those leaves an
 * acyclic graph to layer, and putting them back afterwards is what makes a
 * rework loop draw as an arc returning over the flow rather than dragging its
 * target into a later column.
 */
export function splitBackEdges(
  nodeIds: readonly string[],
  links: readonly Link[],
): { forward: Link[]; back: Link[] } {
  const outgoing = new Map<string, Link[]>();
  for (const link of links) {
    outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), link]);
  }

  const state = new Map<string, "open" | "done">();
  const back = new Set<Link>();

  const walk = (id: string) => {
    state.set(id, "open");
    for (const link of outgoing.get(id) ?? []) {
      const seen = state.get(link.to);
      if (seen === "open") back.add(link);
      else if (seen === undefined) walk(link.to);
    }
    state.set(id, "done");
  };

  for (const id of nodeIds) if (!state.has(id)) walk(id);

  return {
    forward: links.filter((link) => !back.has(link)),
    back: [...back],
  };
}

/* ------------------------------------------------------------------ */
/* 2. Columns                                                          */
/* ------------------------------------------------------------------ */

/**
 * Put each block as far right as its predecessors allow.
 *
 * Longest path rather than shortest: a block waits for everything that feeds
 * it, so an arrow never points backwards along the flow and a step is never
 * drawn before something it depends on.
 */
function assignColumns(nodeIds: readonly string[], forward: readonly Link[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const link of forward) {
    incoming.get(link.to)?.push(link.from);
    outgoing.get(link.from)?.push(link.to);
  }

  const column = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const pending = new Map(nodeIds.map((id) => [id, incoming.get(id)?.length ?? 0]));
  const queue = nodeIds.filter((id) => (pending.get(id) ?? 0) === 0);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of outgoing.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return column;
}

/* ------------------------------------------------------------------ */
/* 3. Order within a column                                            */
/* ------------------------------------------------------------------ */

function averagePosition(
  neighbours: readonly string[],
  order: Map<string, number>,
  fallback: number,
): number {
  const known = neighbours.map((id) => order.get(id)).filter((value): value is number => value !== undefined);
  if (known.length === 0) return fallback;
  return known.reduce((total, value) => total + value, 0) / known.length;
}

/**
 * Sweep up and down, each time putting a block level with its neighbours.
 *
 * The barycentre heuristic: a block sits at the average height of what it
 * connects to, which straightens the common case — a chain — and pulls the two
 * halves of a branch apart. Back edges count too, so a loop's two ends line up
 * rather than the arc cutting diagonally across the drawing.
 */
function orderColumns(
  columns: string[][],
  links: readonly Link[],
  sweeps: number,
): string[][] {
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const link of links) {
    before.set(link.to, [...(before.get(link.to) ?? []), link.from]);
    after.set(link.from, [...(after.get(link.from) ?? []), link.to]);
  }

  let ordered = columns.map((column) => [...column]);
  const positions = () => {
    const order = new Map<string, number>();
    for (const column of ordered) column.forEach((id, index) => order.set(id, index));
    return order;
  };

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = positions();
    const range = downward
      ? ordered.map((_, index) => index)
      : ordered.map((_, index) => ordered.length - 1 - index);

    for (const index of range) {
      const neighbours = downward ? before : after;
      ordered[index] = [...ordered[index]]
        .map((id, position) => ({
          id,
          key: averagePosition(neighbours.get(id) ?? [], order, position),
          position,
        }))
        // Ties keep their previous order, so a sweep never shuffles blocks it
        // has no reason to move.
        .sort((a, b) => a.key - b.key || a.position - b.position)
        .map((item) => item.id);
      ordered[index].forEach((id, position) => order.set(id, position));
    }
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* Coordinates                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where every block in a workflow should sit.
 *
 * Columns are as wide as their widest block, so a row of pills does not leave a
 * step-sized hole. Each column is centred against the tallest, which keeps a
 * plain chain on one line instead of stepping down the page.
 */
export type PlacedWorkflow = {
  positions: Map<string, Point>;
  /** Which column each block landed in. Loop routing reads it to tell an
   *  immediate step-back from one that reaches further. */
  columns: Map<string, number>;
};

export function layoutWorkflow(
  workflow: Workflow,
  options: LayoutOptions = {},
): Map<string, Point> {
  return placeWorkflow(workflow, options).positions;
}

function placeWorkflow(workflow: Workflow, options: LayoutOptions = {}): PlacedWorkflow {
  const settings = { ...DEFAULTS, ...options };
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));

  // Start first, so the walk that finds back edges begins where the workflow does.
  const nodeIds = [...workflow.nodes]
    .sort((a, b) => Number(b.type === "start") - Number(a.type === "start"))
    .map((node) => node.id);

  const links: Link[] = [];
  const seen = new Set<string>();
  for (const edge of workflow.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from: edge.source, to: edge.target });
  }

  const { forward, back } = splitBackEdges(nodeIds, links);
  const column = assignColumns(nodeIds, forward);

  const width = Math.max(0, ...[...column.values()]) + 1;
  const grouped: string[][] = Array.from({ length: width }, () => []);
  for (const id of nodeIds) grouped[column.get(id) ?? 0].push(id);

  const ordered = orderColumns(grouped, [...forward, ...back], settings.sweeps);

  const sizeOf = (id: string) => blockSize(byId.get(id) as WorkflowNode);
  const columnHeights = ordered.map((ids) =>
    ids.reduce((total, id, index) => total + sizeOf(id).h + (index > 0 ? settings.rowGap : 0), 0),
  );
  const tallest = Math.max(0, ...columnHeights);

  const positions = new Map<string, Point>();
  let x = settings.origin.x;

  ordered.forEach((ids, index) => {
    const columnWidth = Math.max(0, ...ids.map((id) => sizeOf(id).w));
    let y = settings.origin.y + (tallest - columnHeights[index]) / 2;

    for (const id of ids) {
      const size = sizeOf(id);
      positions.set(id, {
        // Centred in its column, so a pill sits on the line a step is on.
        x: snapToGrid(x + (columnWidth - size.w) / 2),
        y: snapToGrid(y),
      });
      y += size.h + settings.rowGap;
    }
    x += columnWidth + settings.columnGap;
  });

  return { positions, columns: column };
}

/* ------------------------------------------------------------------ */
/* Loop-backs                                                          */
/* ------------------------------------------------------------------ */

/** Clearance between the row of blocks and the nearest loop arc. */
const LOOP_CLEARANCE = 76;
/** Distance between one loop's arc and the next on the same side. */
const LOOP_LANE = 92;
/** How far down the side a short step-back leaves and arrives. */
const STEP_BACK_V = 0.74;

type LoopRouting = {
  port: EdgeAnchorPoint;
  anchor: EdgeAnchorPoint;
  bend?: Bend;
};

/** Blocks a loop would be drawn across, going over the top or under the bottom. */
export function loopObstacles(
  rects: readonly Rect[],
  span: { left: number; right: number },
  band: { top: number; bottom: number },
): { above: Rect[]; below: Rect[] } {
  const inSpan = (rect: Rect) => rect.left < span.right && rect.left + rect.w > span.left;
  return {
    above: rects.filter((rect) => inSpan(rect) && rect.top < band.top),
    below: rects.filter((rect) => inSpan(rect) && rect.top + rect.h > band.bottom),
  };
}

/**
 * Which way round a loop should go: over the blocks, or under them.
 *
 * "Fewer crossings" measured rather than assumed. The band compared against is
 * the loop's own two blocks, not the whole diagram — an arc leaving the top of
 * one and arriving at the top of the other is drawn across whatever sits above
 * *them*, and the same below. Whichever corridor holds fewer blocks wins. On a
 * single row both are empty and it ties, and the tie goes to the top, where a
 * label is easier to read.
 */
export function clearerSide(
  rects: readonly Rect[],
  span: { left: number; right: number },
  band: { top: number; bottom: number },
): "top" | "bottom" {
  const { above, below } = loopObstacles(rects, span, band);
  return below.length < above.length ? "bottom" : "top";
}

/**
 * Route every connection that runs back against the flow.
 *
 * Left to right, a rework path leaves a block on the right and returns to
 * something earlier on the left — and left to itself it draws as a nearly flat
 * line at the height of the row, which is to say hidden behind every block it
 * passes. A workflow then looks like a chain with no loops in it at all, which is
 * exactly what a reader most needs to see. So none of these leave from the
 * right, and each takes the shape its distance calls for:
 *
 * - **Back one step**, where the two blocks are neighbours: out of the left
 *   side, into the right side of the block before it, low enough to sit under
 *   the forward arrow already in that gap. A short return hop, no arc.
 * - **Further back**: out of the top (or bottom) and into the top (or bottom)
 *   of its target, arching over the blocks in between. Leaving from the top
 *   rather than the right means the line never doubles back on itself. Longer
 *   loops arch further, so one that spans another nests around it, and the
 *   labels — which sit at the apex — end up on separate lines.
 *
 * Stored as ordinary ports, anchors and bends, not as special rendering: the
 * shapes are then the author's, with the same handles as any other line.
 */
function routeLoops(
  workflow: Workflow,
  placed: PlacedWorkflow,
): Map<string, LoopRouting> {
  const routed = new Map<string, LoopRouting>();
  const rectOf = (id: string) => {
    const node = workflow.nodes.find((item) => item.id === id);
    return node ? blockRect(node) : undefined;
  };

  const backwards: { edge: WorkflowEdge; span: number; steps: number }[] = [];
  for (const edge of workflow.edges) {
    const from = rectOf(edge.source);
    const to = rectOf(edge.target);
    if (!from || !to || edge.source === edge.target) continue;
    // Against the flow: the target sits at or before the block it leaves.
    if (to.left + to.w > from.left) continue;
    backwards.push({
      edge,
      span: from.left - to.left,
      steps:
        (placed.columns.get(edge.source) ?? 0) - (placed.columns.get(edge.target) ?? 0),
    });
  }
  if (backwards.length === 0) return routed;

  const rects = workflow.nodes.map((node) => blockRect(node));

  // Shortest first, so a loop that contains another arches outside it.
  backwards.sort((a, b) => a.span - b.span);

  // Several loops leaving or landing on one block would otherwise share a point.
  const leaving = new Map<string, number>();
  const landing = new Map<string, number>();
  const lanes = { top: 0, bottom: 0 };

  for (const { edge, steps } of backwards) {
    const from = rectOf(edge.source);
    const to = rectOf(edge.target);
    if (!from || !to) continue;

    const out = leaving.get(edge.source) ?? 0;
    const into = landing.get(edge.target) ?? 0;
    leaving.set(edge.source, out + 1);
    landing.set(edge.target, into + 1);

    // Neighbours: a short hop back through the gap they already share.
    if (steps === 1) {
      routed.set(edge.id, {
        port: { u: 0, v: STEP_BACK_V + out * 0.1 },
        anchor: { u: 1, v: STEP_BACK_V + into * 0.1 },
      });
      continue;
    }

    const span = { left: to.left, right: from.left + from.w };
    const band = {
      top: Math.min(from.top, to.top),
      bottom: Math.max(from.top + from.h, to.top + to.h),
    };
    const side = clearerSide(rects, span, band);
    const lane = lanes[side];
    lanes[side] += 1;

    const v = side === "top" ? 0 : 1;
    const port: EdgeAnchorPoint = { u: 0.5 + out * 0.14, v };
    const anchor: EdgeAnchorPoint = { u: 0.5 + into * 0.14, v };

    const start = portFromAnchor(from, port);
    const finish = entryPoint(to, start, anchor);

    // Clear of everything in the corridor, not merely of the two blocks the
    // loop joins: an arc that cleared only its own ends would still be drawn
    // through anything taller in between.
    const { above, below } = loopObstacles(rects, span, band);
    const obstacles = side === "top" ? above : below;
    const edgeOfEverything =
      side === "top"
        ? Math.min(band.top, ...obstacles.map((rect) => rect.top))
        : Math.max(band.bottom, ...obstacles.map((rect) => rect.top + rect.h));

    const clearance = LOOP_CLEARANCE + lane * LOOP_LANE;
    const apex = {
      x: (start.x + finish.x) / 2,
      y: side === "top" ? edgeOfEverything - clearance : edgeOfEverything + clearance,
    };

    // Solved rather than reasoned about: `bendFromPoint` is the exact inverse
    // of what the canvas applies, so the arc passes through this point.
    routed.set(edge.id, {
      port,
      anchor,
      bend: bendFromPoint(start, finish, "curved", apex),
    });
  }

  return routed;
}

/**
 * Place a workflow's blocks, and arch its loops over them.
 *
 * Returns the workflow unchanged when it has no blocks, so a caller can apply
 * this unconditionally to a freshly drafted workflow.
 */
export function withLayout(workflow: Workflow, options: LayoutOptions = {}): Workflow {
  if (workflow.nodes.length === 0) return workflow;
  const placed = placeWorkflow(workflow, options);
  const positioned: Workflow = {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const position = placed.positions.get(node.id);
      return position ? { ...node, position } : node;
    }),
  };

  const loops = routeLoops(positioned, placed);
  return {
    ...positioned,
    edges: positioned.edges.map((edge) => {
      const routing = loops.get(edge.id);
      return routing ? { ...edge, ...routing } : edge;
    }),
  };
}

/**
 * How many pairs of edges cross, counted geometrically.
 *
 * Exists so the layout's claims can be measured rather than asserted. Straight
 * chords between block centres, which is close enough to compare two layouts of
 * the same graph.
 */
export function countCrossings(workflow: Workflow): number {
  const centres = new Map<string, Point>();
  for (const node of workflow.nodes) {
    const size = blockSize(node);
    centres.set(node.id, {
      x: (node.position?.x ?? 0) + size.w / 2,
      y: (node.position?.y ?? 0) + size.h / 2,
    });
  }

  const segments = workflow.edges
    .filter((edge) => centres.has(edge.source) && centres.has(edge.target))
    .map((edge) => ({
      edge,
      a: centres.get(edge.source) as Point,
      b: centres.get(edge.target) as Point,
    }));

  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));

  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const one = segments[i];
      const two = segments[j];
      // Edges meeting at a shared block are not a crossing.
      const shared =
        one.edge.source === two.edge.source ||
        one.edge.source === two.edge.target ||
        one.edge.target === two.edge.source ||
        one.edge.target === two.edge.target;
      if (shared) continue;

      const d1 = side(one.a, one.b, two.a);
      const d2 = side(one.a, one.b, two.b);
      const d3 = side(two.a, two.b, one.a);
      const d4 = side(two.a, two.b, one.b);
      if (d1 !== d2 && d3 !== d4) crossings += 1;
    }
  }
  return crossings;
}

export const LAYOUT_GRID = GRID;
