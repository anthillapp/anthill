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
  isSwitcher,
  outputsOf,
  switcherProblem,
  type ActionCategory,
  type BlockOutput,
} from "@anthill/workflow";

import {
  ENTRY_LEAD,
  LABEL_CLEARANCE,
  entryPoint,
  labelHalfSize,
  labelSpot,
  loopBelow,
  passesUnder,
  pointsAlong,
  portFromAnchor,
  portPoint,
  portSideToward,
  route,
  unconnectedStub,
  type CurveGeometry,
  type EntryPoint,
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
/** Room for a name the estimate puts a pixel or two short. */
const PILL_SLACK = 8;

/**
 * The size a control pill needs for its name: wider first, then taller.
 *
 * Start and End take whatever name the author gives them, and the shape never
 * followed. "Ready for the PR" wrapped to three cramped lines inside 108×40.
 */
function pillSize(name: string): { w: number; h: number } {
  // A few pixels over the estimate, and rounded up to the grid, never down:
  // "Approved" came out one pixel short of its own width, and a pill's name
  // that does not fit breaks mid-word — "Approve / d" (ANT-213).
  const wanted = PILL_CHROME + name.trim().length * PILL_CHAR + PILL_SLACK;
  if (wanted <= PILL_SIZE.w) return PILL_SIZE;

  const w = Math.min(Math.ceil(wanted / GRID) * GRID, PILL_MAX.w);
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
  // A switcher's fingers: thin and solid. Thin because each is one alternative
  // of one path; the stem carries the weight (ANT-165).
  switch: { color: "#444141", width: 1.25 },
};

/*
  The switcher (ANT-165): a block's two or more connected `switch` exits drawn
  as one heavy stem into a hub, and a thin finger from the hub to each target.
  Heavy to light is deliberate — one path that parts into alternatives — and
  the hub is drawn over the fingers' starts, or it reads as several arrows
  that happen to begin at the same spot, which is what this replaces.
*/

/** How far the hub sits from where the stem leaves the block. */
export const SWITCH_STEM = 40;
export const SWITCH_HUB_RADIUS = 12;
export const SWITCH_INK = "#444141";
/** Stem and hub when the exits do not decide exactly one path. */
export const SWITCH_WARN = { stroke: "#d8a21a", fill: "#fdf8ec" };

/** Lucide `split`, on its 24-unit grid. Turned to open rightward when drawn. */
export const SWITCH_GLYPH_PATHS = [
  "M16 3h5v5",
  "M8 3H3v5",
  "M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3",
  "m15 9 6-6",
] as const;

/** Places the 24-unit glyph as 14 units inside the hub, opening rightward. */
export function switchGlyphTransform(hub: Point): string {
  return `translate(${hub.x - 7} ${hub.y - 7}) rotate(90 7 7) scale(0.5833)`;
}

/** The stem, from its port to the hub's rim. */
export function switchStemPath(shape: { port: Point; hub: Point }): string {
  return `M ${shape.port.x} ${shape.port.y} L ${shape.hub.x - SWITCH_HUB_RADIUS} ${shape.hub.y}`;
}

export type SwitcherShape = {
  nodeId: string;
  /** Where the stem leaves the block — the switcher's one port dot. */
  port: PortPoint;
  hub: Point;
  /** The exits it chooses between, in port order. */
  outputIds: string[];
  /** Why "exactly one" does not hold, when it does not. */
  problem?: string;
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
  /** Set on a switcher's finger: the block whose switcher it leaves from its hub. */
  switcher?: string;
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
  switchers: SwitcherShape[];
};

/**
 * Work out every port, path and label position for a workflow.
 *
 * Labels are placed last and against every block, so a label pushed off one
 * curve does not land on a card belonging to another.
 */
/** How far under its row a loop back along the row runs, and how much deeper for each loop it spans. */
const LOOP_DEPTH = 30;
/** How far apart two detours over the same stretch run, and how many lanes out to try. */
const LANE_GAP = 22;
const LANE_TRIES = 6;
const LOOP_STEP = 22;

/**
 * A spot for a detour's label on its own lane, as near where it leaves as is
 * clear.
 *
 * At the middle of the line, where the bend handle is, a label has to step
 * off the line to clear it — and over a row, stepping off means climbing
 * across the lanes of every other detour. The labels of W13's switcher
 * fingers floated in empty space, nearer the wrong finger than their own
 * (ANT-213). On the lane itself, the label sits on the line it names.
 */
function onLane(
  lane: NonNullable<CurveGeometry["lane"]>,
  halfW: number,
  halfH: number,
  obstacles: readonly Rect[],
): Point | undefined {
  const clear = (x: number) =>
    !obstacles.some(
      (rect) =>
        rect.left < x + halfW && x - halfW < rect.left + rect.w && rect.top < lane.y + halfH && lane.y - halfH < rect.top + rect.h,
    );
  for (let x = lane.left + DETOUR_LABEL_INSET + halfW; x + halfW <= lane.right - DETOUR_LABEL_INSET; x += GRID) {
    if (clear(x)) return { x, y: lane.y };
  }
  return undefined;
}

/** How far in from a detour's corners its label keeps. */
const DETOUR_LABEL_INSET = 24;

function rectAt(point: Point, halfW: number, halfH: number): Rect {
  return { left: point.x - halfW, top: point.y - halfH, w: halfW * 2, h: halfH * 2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
}

/** How near the closest of `points` comes to `point`. */
function nearest(point: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (const other of points) best = Math.min(best, Math.hypot(other.x - point.x, other.y - point.y));
  return best;
}

/**
 * A spot for a short finger's label on the finger itself, as near the hub as
 * is clear of the blocks, of `taken`, and of every other line.
 *
 * The bend handle is kept clear when the finger has room for that. A finger
 * between a switcher and an End just past it often has not, and then the label
 * sits on the handle's spot: the handle is drawn over labels, so it can still
 * be grabbed, and a label on its own line is never read as another's.
 */
function onFinger(
  own: readonly Point[],
  others: readonly Point[],
  halfW: number,
  halfH: number,
  blocks: readonly Rect[],
  taken: readonly Rect[],
  handle: Rect,
): Point | undefined {
  const clear = (point: Point, avoid: readonly Rect[]) => {
    const box = rectAt(point, halfW, halfH);
    return (
      !blocks.some((block) =>
        overlaps(box, {
          left: block.left - LABEL_CLEARANCE,
          top: block.top - LABEL_CLEARANCE,
          w: block.w + LABEL_CLEARANCE * 2,
          h: block.h + LABEL_CLEARANCE * 2,
        }),
      ) &&
      !avoid.some((rect) => overlaps(box, rect)) &&
      !others.some((other) => Math.abs(other.x - point.x) < halfW && Math.abs(other.y - point.y) < halfH)
    );
  };
  return own.find((point) => clear(point, [...taken, handle])) ?? own.find((point) => clear(point, taken));
}

/**
 * A spot beside a finger, for a label its finger has no room to hold.
 *
 * A finger between a hub and the step in line with it is often shorter than
 * its label, and one into an End just past the hub may run where every spot
 * on it touches a block. The label then stayed wherever it was first put —
 * above the row, nearer another line than its own, or on another line's lane
 * (ANT-250). Beside its own finger, just above or below it, it still reads as
 * that finger's: no other line runs through it, no block is under it, and its
 * own line is the nearest one. The closest such spot wins, nearest the hub
 * first.
 */
function besideFinger(
  own: readonly Point[],
  others: readonly Point[],
  halfW: number,
  halfH: number,
  blocks: readonly Rect[],
  taken: readonly Rect[],
): Point | undefined {
  let best: { point: Point; distance: number } | undefined;
  const lifts = [0, halfH + 4, -(halfH + 4), halfH + 14, -(halfH + 14), halfH + 26, -(halfH + 26)];
  const shifts = [0, -halfW / 2, halfW / 2, -halfW, halfW];
  for (const point of own) {
    for (const dy of lifts) {
      for (const dx of shifts) {
        const at = { x: point.x + dx, y: point.y + dy };
        const box = rectAt(at, halfW, halfH);
        if (blocks.some((block) => overlaps(box, block))) continue;
        if (taken.some((rect) => overlaps(box, rect))) continue;
        if (others.some((other) => Math.abs(other.x - at.x) < halfW && Math.abs(other.y - at.y) < halfH)) continue;
        const distance = nearest(at, own);
        if (distance >= nearest(at, others)) continue;
        if (!best || distance < best.distance - 0.5) best = { point: at, distance };
      }
    }
  }
  return best?.point;
}

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
  const switchers: SwitcherShape[] = [];
  /** How each connection's label was placed: its size, side and handle. Read again once every lane is known. */
  const placing: { halfW: number; halfH: number; prefer?: "up" | "down"; handle: Rect }[] = [];
  /** The lanes detours already run in, so the next one keeps off them. */
  const lanes: NonNullable<CurveGeometry["lane"]>[] = [];
  const laneTaken = (lane: NonNullable<CurveGeometry["lane"]>) =>
    lanes.some(
      (other) =>
        other.up === lane.up &&
        Math.abs(other.y - lane.y) < LANE_GAP &&
        other.left < lane.right &&
        lane.left < other.right,
    );

  /** A block's exits that leave from a switcher's hub rather than a port of their own. */
  const fingersOf = (outputs: readonly BlockOutput[]): Set<string> =>
    isSwitcher(outputs)
      ? new Set(outputs.filter((output) => output.kind === "switch" && output.target !== null).map((output) => output.id))
      : new Set();

  /*
    A loop back to a step earlier in the same row, with nothing placed by
    hand, leaves the bottom of its step and arrives at the bottom of the step
    it returns to. Landed on that step's left side, as any connection from the
    same row is, it could only get there straight through the step — along
    the forward line and behind the card, where it read as nothing (ANT-196).
    Under the row is where the templates' own loops say they go (ANT-194).
    Several loops leaving or arriving at one step are spread along its
    bottom, nearest source innermost, so they nest rather than cross.

    A switcher's exit back along the row is such a loop too. Left out, it
    went from the hub straight back along the row to the left side of the
    step it returns to: on the forward line, behind the card, its label
    floating over the row (ANT-272). It still leaves from the hub, as every
    exit of a switcher does, but drops from there and runs under the row
    into the bottom of that step like any other loop.
  */
  const sameRow = (a: Rect, b: Rect) => a.top < b.top + b.h && b.top < a.top + a.h;
  const loopsUnder = new Map<string, { leave: number; arrive: number; depth: number }>();
  {
    const loops: {
      key: string;
      source: string;
      target: string;
      finger: boolean;
      reach: number;
      left: number;
      right: number;
      row: Rect;
    }[] = [];
    for (const node of workflow.nodes) {
      const rect = rects.get(node.id);
      if (!rect) continue;
      const outputs = outputsOf(workflow, node.id);
      const fingers = fingersOf(outputs);
      for (const output of outputs) {
        if (output.target === null || output.port || output.anchor) continue;
        const targetRect = rects.get(output.target);
        if (!targetRect || !sameRow(rect, targetRect)) continue;
        if (portSideToward(rect, targetRect) !== "left") continue;
        const finger = fingers.has(output.id);
        loops.push({
          key: `${node.id}:${output.id}`,
          source: node.id,
          target: output.target,
          finger,
          reach: rect.left - targetRect.left,
          left: targetRect.left,
          right: rect.left + rect.w + (finger ? SWITCH_STEM : 0),
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
    // A switcher's exits leave from its hub, so only the others share the bottom.
    for (const id of new Set(loops.map((loop) => loop.source))) {
      spread(loops.filter((loop) => loop.source === id && !loop.finger), 0.65, -1, "leave");
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
    const fingers = fingersOf(outputs);
    const automatic = outputs.filter((output) => !output.port && !under(output) && !fingers.has(output.id));
    const sideOf = new Map<(typeof outputs)[number], "left" | "right">();
    for (const output of automatic) {
      const targetRect = output.target === null ? undefined : rects.get(output.target);
      // An output with nowhere to go leaves forwards: there is no target to
      // read a direction from, and forwards is what it will most likely become.
      sideOf.set(output, targetRect ? (portSideToward(rect, targetRect) as "left" | "right") : "right");
    }

    /*
      A switcher takes one slot on the right edge, the middle one, and the
      block's other forward ports spread either side of it — so a plain
      arrow never leaves from under the stem. Alone, that is the right edge's
      centre.
    */
    const rightSharing = automatic.filter((item) => sideOf.get(item) === "right");
    const stemSlot = Math.floor(rightSharing.length / 2);
    const rightSlots = rightSharing.length + (fingers.size > 0 ? 1 : 0);
    const slotOf = (output: BlockOutput, side: "left" | "right", sharing: readonly BlockOutput[]) => {
      const at = sharing.indexOf(output);
      if (side !== "right" || fingers.size === 0) return { index: at, count: sharing.length };
      return { index: at >= stemSlot ? at + 1 : at, count: rightSlots };
    };

    let switcher: SwitcherShape | undefined;
    if (fingers.size > 0) {
      const port = portPoint(rect, stemSlot, rightSlots, "right");
      const problem = switcherProblem(outputs);
      switcher = {
        nodeId: node.id,
        port,
        hub: { x: port.x + SWITCH_STEM, y: port.y },
        outputIds: [...fingers],
        ...(problem ? { problem } : {}),
      };
      switchers.push(switcher);
      // Nothing else's label may sit on the stem or the hub.
      placed.push({
        left: port.x,
        top: port.y - SWITCH_HUB_RADIUS,
        w: SWITCH_STEM + SWITCH_HUB_RADIUS,
        h: SWITCH_HUB_RADIUS * 2,
      });
    }

    outputs.forEach((output, index) => {
      const side = sideOf.get(output) ?? "right";
      const sharing = automatic.filter((item) => sideOf.get(item) === side);
      const loop = under(output);
      const slot = slotOf(output, side, sharing);
      const finger = switcher && fingers.has(output.id) ? switcher : undefined;
      const port: PortPoint = finger
        ? { ...finger.hub, side: loop ? "bottom" : "right" }
        : output.port
          ? portFromAnchor(rect, output.port)
          : loop
            ? portFromAnchor(rect, { u: loop.leave, v: 1 })
            : portPoint(rect, slot.index, slot.count, side);
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
      // A finger to the block in line with the hub is a straight line: in the
      // short gap after the hub a curve kinks backwards. Not when a block
      // stands between them, though: a switcher's exit to the second of two
      // steps in its row ran straight through the first and read as leaving
      // it (ANT-259). That one goes round, as any other line does.
      const inLine = Boolean(finger) && !output.bend && landing.side === "left" && Math.abs(landing.y - port.y) < 4;
      const direct = inLine ? straight(port, landing) : undefined;
      let geometry =
        direct && !passesUnder(port, landing, direct, blocks) ? direct : route(port, landing, options);
      /*
        A finger to a block just past the hub, a little above or below it,
        landed on that block's bottom or top. A curve lines up for those from
        further out than the hub is, so it swung past the hub's height the
        wrong way before turning back: W29's last switcher, an End either side
        of its hub, drew two fingers that crossed, and each label then sat by
        the other line (ANT-239). Ahead of the hub and that close, the way in
        is the block's near side, and the fingers fan out. Only for a finger
        drawn as a curve: one sent round blocks arrives the way its lane does.
      */
      if (
        finger &&
        !output.anchor &&
        !output.bend &&
        !geometry.lane &&
        (landing.side === "top" || landing.side === "bottom") &&
        targetRect.left > port.x &&
        Math.abs(landing.y - port.y) < ENTRY_LEAD
      ) {
        const side = entryPoint(targetRect, port, { u: 0, v: (port.y - targetRect.top) / targetRect.h });
        const beside = route(port, side, options);
        if (!beside.lane) {
          landing = side;
          geometry = beside;
        }
      }
      /*
        A line sent round over the row to a block above its port still landed
        on that block's bottom, the side facing the port, so its last leg
        dropped from the lane through the block and its arrow pointed up from
        underneath: a first review's "passed" to the upper of two stacked Ends
        (ANT-254). Sent round over the top, the way in is the block's left
        side, high up; under the bottom, low down.
      */
      if (
        geometry.lane &&
        !output.anchor &&
        !output.bend &&
        (geometry.lane.up ? landing.side === "bottom" : landing.side === "top")
      ) {
        const side = entryPoint(targetRect, port, { u: 0, v: geometry.lane.up ? 0.3 : 0.7 });
        const beside = route(port, side, options);
        if (!passesUnder(port, side, beside, blocks)) {
          landing = side;
          geometry = beside;
        }
      }
      /*
        Two lines sent round the same blocks took the same lane: every detour
        runs at the nearest clear height, so a switcher's fingers to two ends
        past the row ran one on top of the other, and nothing said which hub
        each left (ANT-213). A lane already taken over the same stretch sends
        the next line one lane further out.
      */
      for (let step = 1; step <= LANE_TRIES && geometry.lane && laneTaken(geometry.lane); step += 1) {
        geometry = route(port, landing, { ...options, lift: step * LANE_GAP });
      }
      if (geometry.lane) lanes.push(geometry.lane);
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
      // A finger's label is the exit's name alone; its condition is read in
      // the inspector, not on the canvas.
      const { halfW, halfH } = finger
        ? labelHalfSize(output.label || " ")
        : labelHalfSize(output.label || " ", {
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

      // Where connections meet at one step and do not part from one, the
      // label goes on the side its own source lies: the one from above over
      // the one from below. By the direction of travel alone the two labels
      // swapped places between the lines (ANT-178, seen on a drafted join).
      const meets =
        workflow.edges.filter((edge) => edge.target === output.target).length > 1 &&
        outputs.filter((item) => item.target !== null).length === 1;
      const prefer = meets && Math.abs(geometry.from.y - geometry.to.y) > 4
        ? geometry.from.y < geometry.to.y ? "up" : "down"
        : undefined;
      const obstacles = [...blocks, handleSpot, ...placed];
      const label =
        (geometry.lane && !output.bend ? onLane(geometry.lane, halfW, halfH, obstacles) : undefined) ??
        labelSpot(geometry, halfW, halfH, obstacles, prefer);
      placed.push({ left: label.x - halfW, top: label.y - halfH, w: halfW * 2, h: halfH * 2 });

      placing.push({ halfW, halfH, prefer, handle: handleSpot });
      connected.push({
        nodeId: node.id,
        output,
        index,
        geometry,
        label,
        style,
        port,
        ...(finger ? { switcher: node.id } : {}),
      });
    });
  }

  /*
    A label across another line's lane, or on it, reads as that line's. W13's
    "Summary corrections" labels a short finger in line with its hub, too short
    to hold it, and climbed over both lanes above the row (ANT-213). Lanes are
    only all known once every line is routed, so labels are looked at again,
    in the order they were placed: one that is clear of every lane, and of the
    labels already settled, stays where it is; any other is placed again, on
    the other side of its line if its own side takes it across a lane.
  */
  if (lanes.length > 0) {
    const across = (label: Point, from: Point, halfH: number, own?: CurveGeometry["lane"]) =>
      lanes.some(
        (lane) =>
          lane !== own &&
          lane.left <= label.x &&
          label.x <= lane.right &&
          Math.min(label.y, from.y) - halfH < lane.y &&
          lane.y < Math.max(label.y, from.y) + halfH,
      );
    const onLaneLabel = (path: ConnectedPath) => Boolean(path.geometry.lane) && !path.output.bend;
    // Labels on their own lane are where they belong; the rest fit round them.
    const settled: Rect[] = connected.flatMap((path, index) =>
      onLaneLabel(path) ? [rectAt(path.label, placing[index].halfW, placing[index].halfH)] : [],
    );
    connected.forEach((path, index) => {
      if (onLaneLabel(path)) return;
      const { halfW, halfH, prefer, handle } = placing[index];
      const mid = path.geometry.mid;
      const clearOfSettled = (point: Point) => !settled.some((rect) => overlaps(rect, rectAt(point, halfW, halfH)));
      let label = path.label;
      // Only a level line changes sides. One that climbs or falls has its
      // label on the side it heads, or the labels of a fork read as each
      // other's (ANT-178); across a lane is the lesser evil there.
      const { from, to } = path.geometry;
      const level = Math.abs(to.y - from.y) <= Math.hypot(to.x - from.x, to.y - from.y) * 0.2;
      if ((level && across(label, mid, halfH)) || !clearOfSettled(label)) {
        const bands = lanes.map((lane) => ({ left: lane.left, top: lane.y - 2, w: lane.right - lane.left, h: 4 }));
        const obstacles = [...blocks, handle, ...bands, ...settled];
        label = labelSpot(path.geometry, halfW, halfH, obstacles, prefer);
        if (level && across(label, mid, halfH)) {
          const other = labelSpot(path.geometry, halfW, halfH, obstacles, label.y < mid.y ? "down" : "up");
          // A little further is worth it: across a lane a label reads as that
          // line's. Much further is not — then it is lost either way.
          const near = Math.abs(other.y - mid.y) <= Math.max(Math.abs(label.y - mid.y) * 2, 60);
          if (near && !across(other, mid, halfH)) label = other;
        }
        connected[index] = { ...path, label };
      }
      settled.push(rectAt(label, halfW, halfH));
    });
  }

  /*
    A short finger's label went where the room was, and in a corner that can
    be by another line. W29's last switcher has an End just past its hub on
    either side, under the lane of the first review's "Approved": its own
    "Approved" was put on that lane (ANT-239). Once every line is drawn, a
    finger's label that another line runs through, or that is nearer another
    line than its own, goes on its own finger instead.
  */
  if (switchers.length > 0) {
    const lines = connected.map((path) => pointsAlong(path.geometry.path));
    const hubs = switchers.map((shape) => ({
      left: shape.port.x,
      top: shape.port.y - SWITCH_HUB_RADIUS,
      w: SWITCH_STEM + SWITCH_HUB_RADIUS,
      h: SWITCH_HUB_RADIUS * 2,
    }));
    connected.forEach((path, index) => {
      // A finger looping back under the row is labelled on its run under the
      // row, as any loop is, not by the hub it drops from (ANT-272).
      if (!path.switcher || path.geometry.lane || loopsUnder.has(`${path.nodeId}:${path.output.id}`)) return;
      const { halfW, halfH, handle } = placing[index];
      const own = lines[index];
      const others = lines.filter((_, other) => other !== index).flat();
      const through = others.some(
        (point) => Math.abs(point.x - path.label.x) < halfW && Math.abs(point.y - path.label.y) < halfH,
      );
      const toOwn = nearest(path.label, own);
      // Off its own line by more than its own height is not on it either: the
      // label reads as floating, or as the label of whatever is nearer (ANT-250).
      const away = toOwn > halfH + LABEL_CLEARANCE;
      // On its finger, but out by the step it leads to rather than by the hub
      // it leaves: read along the row, it names the next connection.
      const fromHub = (point: Point) => Math.hypot(point.x - own[0].x, point.y - own[0].y);
      const farOut = own.length > 1 && fromHub(path.label) > Math.hypot(path.label.x - own[own.length - 1].x, path.label.y - own[own.length - 1].y);
      if (!through && !away && !farOut && toOwn <= nearest(path.label, others)) return;
      const taken = [
        ...hubs,
        ...connected.flatMap((other, at) => (at === index ? [] : [rectAt(other.label, placing[at].halfW, placing[at].halfH)])),
      ];
      const label =
        onFinger(own, others, halfW, halfH, blocks, taken, handle) ??
        besideFinger(own, others, halfW, halfH, blocks, taken);
      // Only ever nearer its own line, or nearer its hub, than where it was.
      if (label && (through || nearest(label, own) < toOwn || (farOut && fromHub(label) < fromHub(path.label)))) {
        connected[index] = { ...path, label };
      }
    });
  }

  return { rects, connected, pending, switchers };
}

/** A straight line between two points, in the shape the router returns. */
function straight(from: PortPoint, to: EntryPoint): CurveGeometry {
  return {
    path: `M ${from.x} ${from.y} L ${to.x} ${to.y}`,
    mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    from,
    to,
  };
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
