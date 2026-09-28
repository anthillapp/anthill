/**
 * Arrow geometry for the canvas.
 *
 * Pure functions over rectangles and points: no React, no workflow model, no
 * knowledge of what an output is. That keeps the fiddliest part of the canvas —
 * where a curve starts, where it lands, and where its label can sit without
 * covering a block — testable without rendering anything.
 *
 * The numbers here are from the design handoff and are reproduced exactly.
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; w: number; h: number };
export type Side = "top" | "right" | "bottom" | "left";
export type EntryPoint = Point & { side: Side };

/** Where an output leaves its block, and which way it sets off. */
export type PortPoint = Point & { side: Side };

/** How a line is drawn between its two ends. */
export type Routing = "curved" | "orthogonal";

/**
 * The author's adjustment to a line's shape, in fractions of the straight line
 * between its ends. Relative, so it survives moving either block.
 */
export type Bend = { along: number; across: number };

/** Fractions of a block's box, 0..1 from its top-left corner. */
export type AnchorPoint = { u: number; v: number };

export type CurveGeometry = {
  /** SVG path data. A cubic bezier when curved, a polyline when stepped. */
  path: string;
  /** Middle of the line: where the label starts and where the bend handle sits. */
  mid: Point;
  from: PortPoint;
  to: EntryPoint;
  /** Which axis a stepped line turns on. Absent for curves. */
  turn?: "x" | "y";
};

/** Unit vector pointing away from a block, per side. */
const OUTWARD: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export function outward(side: Side): Point {
  return OUTWARD[side];
}

/** Vertical spacing between a block's output ports. */
export const PORT_SPACING = 22;

/**
 * How far a port sits outside its block.
 *
 * Sitting exactly on the edge, a port half-overlaps the card and reads as part
 * of the border rather than as something to grab.
 */
export const PORT_OFFSET = 8;

/** Length of the straight run out of each block on a stepped line. */
export const ELBOW_STUB = 26;

/** How far a label may be pushed off the line before giving up. */
const LABEL_OFFSETS = [0, 18, 30, 44, 60, 78, 98, 120];

/** Clearance kept between a label and any block. */
const LABEL_CLEARANCE = 7;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where an output leaves its block.
 *
 * Ports run just outside one edge, evenly spaced and centred on the block, so
 * a block with three outputs on a side shows three ports rather than stacking
 * them.
 *
 * The side matters. Every port used to leave the right edge whatever it
 * connected to, which meant a rework edge — the one that sends work *back* to
 * an earlier step — set off forwards and then swept around the whole block to
 * get where it was going. On a workflow with several loops those sweeps
 * crossed everything. A port that leaves from the side its target is on says
 * which way the work goes before the line is even followed.
 */
export function portPoint(
  rect: Rect,
  index: number,
  count: number,
  side: Side = "right",
): PortPoint {
  const spread = (index - (count - 1) / 2) * PORT_SPACING;
  if (side === "left") {
    return { x: rect.left - PORT_OFFSET, y: rect.top + rect.h / 2 + spread, side };
  }
  if (side === "top") {
    return { x: rect.left + rect.w / 2 + spread, y: rect.top - PORT_OFFSET, side };
  }
  if (side === "bottom") {
    return { x: rect.left + rect.w / 2 + spread, y: rect.top + rect.h + PORT_OFFSET, side };
  }
  return { x: rect.left + rect.w + PORT_OFFSET, y: rect.top + rect.h / 2 + spread, side };
}

/**
 * Which edge an output should leave from to reach `target`.
 *
 * Forward is the default and the common case, so the bar for leaving any other
 * side is deliberately high: the target has to be properly behind the block —
 * far enough back that a right-edge port would have to double back — before
 * the port moves to the left edge. A target merely above or below stays on the
 * right, because the diagram reads left to right and a port that wandered to
 * the top edge for a small vertical offset would be noise.
 */
export function portSideToward(rect: Rect, target: Rect): Side {
  // The target must end before this block begins — properly behind, with no
  // overlap. Two blocks half a width apart are side by side, and a port that
  // doubled back for that would be noise rather than information.
  return target.left + target.w <= rect.left ? "left" : "right";
}

/**
 * Project a point given as fractions of a block onto the nearest side of it.
 *
 * Shared by both ends of a connection: an arrow lands *on* the side, a port
 * sits just outside it. Landings are slid away from the corners, where an
 * arrowhead would otherwise sit on the rounding.
 */
export function projectToSide(rect: Rect, anchor: AnchorPoint): EntryPoint {
  const right = rect.left + rect.w;
  const bottom = rect.top + rect.h;
  const px = rect.left + clamp(anchor.u, 0, 1) * rect.w;
  const py = rect.top + clamp(anchor.v, 0, 1) * rect.h;

  const nearest = (
    [
      { side: "left" as const, gap: px - rect.left },
      { side: "right" as const, gap: right - px },
      { side: "top" as const, gap: py - rect.top },
      { side: "bottom" as const, gap: bottom - py },
    ] satisfies { side: Side; gap: number }[]
  ).sort((a, b) => a.gap - b.gap)[0];

  switch (nearest.side) {
    case "left":
      return { x: rect.left, y: clamp(py, rect.top + 12, bottom - 12), side: "left" };
    case "right":
      return { x: right, y: clamp(py, rect.top + 12, bottom - 12), side: "right" };
    case "top":
      return { x: clamp(px, rect.left + 16, right - 16), y: rect.top, side: "top" };
    default:
      return { x: clamp(px, rect.left + 16, right - 16), y: bottom, side: "bottom" };
  }
}

/**
 * Where a port sits once the author has moved it.
 *
 * The port slides around the block's outline and keeps its distance from the
 * card: the anchor picks a spot, the spot is projected onto the nearest side,
 * and the port is pushed `PORT_OFFSET` out from there. So a port can be put
 * anywhere around the block but never on it or drifting away from it.
 */
export function portFromAnchor(rect: Rect, anchor: AnchorPoint): PortPoint {
  const on = projectToSide(rect, anchor);
  const out = OUTWARD[on.side];
  return { x: on.x + out.x * PORT_OFFSET, y: on.y + out.y * PORT_OFFSET, side: on.side };
}

/**
 * Where an arrow lands on its target.
 *
 * With an anchor — the point the author clicked — the landing is projected onto
 * whichever side of the block is nearest, and slid away from the corners. That
 * is what makes the arrowhead sit where it was pointed instead of at the middle
 * of a side.
 *
 * Without one, the side is chosen from where the arrow comes from, and the
 * landing slides along that side to meet it rather than jumping to the centre.
 */
export function entryPoint(
  rect: Rect,
  from: Point,
  anchor?: AnchorPoint | null,
): EntryPoint {
  const right = rect.left + rect.w;
  const bottom = rect.top + rect.h;

  if (anchor) return projectToSide(rect, anchor);

  if (from.y < rect.top - 24) {
    return { x: clamp(from.x, rect.left + 16, right - 16), y: rect.top, side: "top" };
  }
  if (from.y > bottom + 24) {
    return { x: clamp(from.x, rect.left + 16, right - 16), y: bottom, side: "bottom" };
  }
  return { x: rect.left, y: clamp(from.y, rect.top + 12, bottom - 12), side: "left" };
}

/** A port whose side may be left out, in which case it leaves to the right. */
type LooseFrom = Point & { side?: Side };

function departure(a: LooseFrom): PortPoint {
  return { x: a.x, y: a.y, side: a.side ?? "right" };
}

/** The chord between the two ends, and the frame a bend is expressed in. */
function chordFrame(from: Point, to: Point): { u: Point; n: Point; length: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    u: { x: dx / length, y: dy / length },
    n: { x: -dy / length, y: dx / length },
    length,
  };
}

/** How far the author's bend moves the middle of the line. */
function bendOffset(from: Point, to: Point, bend: Bend): Point {
  const { u, n, length } = chordFrame(from, to);
  return {
    x: (u.x * bend.along + n.x * bend.across) * length,
    y: (u.y * bend.along + n.y * bend.across) * length,
  };
}

function hasBend(bend: Bend | null | undefined): bend is Bend {
  return Boolean(bend) && (bend!.along !== 0 || bend!.across !== 0);
}

/**
 * The cubic bezier between a port and a landing point.
 *
 * The line leaves along the port's side and arrives along the target's, which
 * is what makes a port on the top of a block set off upwards rather than
 * sideways. A bend shifts both control points by the same amount, so the middle
 * of the curve lands exactly where the author dragged it while the two ends
 * stay put.
 */
function curveControls(from: PortPoint, b: EntryPoint, bend?: Bend | null): { c1: Point; c2: Point } {
  const dx = clamp(Math.abs(b.x - from.x) * 0.5, 18, 96);

  const lead =
    from.side === "left" || from.side === "right"
      ? dx
      : clamp(Math.abs(b.y - from.y) * 0.5, 18, 96);
  const out = OUTWARD[from.side];
  let c1: Point = { x: from.x + out.x * lead, y: from.y + out.y * lead };

  let c2: Point =
    b.side === "top"
      ? { x: b.x, y: b.y - 64 }
      : b.side === "bottom"
        ? { x: b.x, y: b.y + 64 }
        : b.side === "right"
          ? { x: b.x + Math.max(48, dx), y: b.y }
          : { x: b.x - dx, y: b.y };

  if (hasBend(bend)) {
    const offset = bendOffset(from, b, bend);
    // B(0.5) moves by 6/8 of a shift applied to both control points, so scale
    // the wanted movement by 4/3 to land the middle exactly on it.
    const shift = { x: (offset.x * 4) / 3, y: (offset.y * 4) / 3 };
    c1 = { x: c1.x + shift.x, y: c1.y + shift.y };
    c2 = { x: c2.x + shift.x, y: c2.y + shift.y };
  }
  return { c1, c2 };
}

export function curve(a: LooseFrom, b: EntryPoint, bend?: Bend | null): CurveGeometry {
  const from = departure(a);
  const { c1, c2 } = curveControls(from, b, bend);

  return {
    path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
    mid: {
      x: (from.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
      y: (from.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
    },
    from,
    to: b,
  };
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

/** The point half way along a polyline, by length. */
function polylineMid(points: readonly Point[]): Point {
  const spans = points.slice(1).map((point, index) => Math.hypot(
    point.x - points[index].x,
    point.y - points[index].y,
  ));
  const half = spans.reduce((total, span) => total + span, 0) / 2;

  let walked = 0;
  for (let index = 0; index < spans.length; index += 1) {
    if (walked + spans[index] >= half) {
      const t = spans[index] === 0 ? 0 : (half - walked) / spans[index];
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * t,
        y: points[index].y + (points[index + 1].y - points[index].y) * t,
      };
    }
    walked += spans[index];
  }
  return points[points.length - 1];
}

/** Where a stepped line's corners fall, before it is turned into a path. */
function elbowPoints(
  from: PortPoint,
  b: EntryPoint,
  bend?: Bend | null,
  /** A row to travel along instead, when the direct step would cross blocks. */
  lift?: number,
): { points: Point[]; turn: "x" | "y"; a: Point; c: Point; base: number } {
  const out0 = OUTWARD[from.side];
  const out3 = OUTWARD[b.side];
  const a: Point = { x: from.x + out0.x * ELBOW_STUB, y: from.y + out0.y * ELBOW_STUB };
  const c: Point = { x: b.x + out3.x * ELBOW_STUB, y: b.y + out3.y * ELBOW_STUB };

  const horizontal = out0.x !== 0;
  // Turning on the departure axis only works while the target is ahead of the
  // port. Behind it, the line has to step out sideways and come back, or it
  // would run straight back over the block it just left.
  const ahead = horizontal ? (c.x - a.x) * out0.x > 0 : (c.y - a.y) * out0.y > 0;
  const turn: "x" | "y" = horizontal === ahead ? "x" : "y";

  // Ahead, the turn belongs half way along and the line reads as a symmetric
  // step. Coming back round, it belongs level with the target's own straight
  // run: that is the one crossing guaranteed to be clear of both blocks,
  // whereas half way is usually straight through the block being left.
  const base = ahead ? 0.5 : 1;
  const f = clamp(base + (bend?.along ?? 0), -0.5, 1.5);

  const corners: Point[] =
    turn === "x"
      ? [
          { x: a.x + (c.x - a.x) * f, y: a.y },
          { x: a.x + (c.x - a.x) * f, y: c.y },
        ]
      : [
          { x: a.x, y: a.y + (c.y - a.y) * f },
          { x: c.x, y: a.y + (c.y - a.y) * f },
        ];

  // Out of the row, across, and back down into it. A stepped line cannot get
  // past anything by sliding its turn along: both of its long runs sit at the
  // heights of its two ends, which on a single-row workflow is the row itself.
  const detour: Point[] = [
    { x: a.x, y: lift as number },
    { x: c.x, y: lift as number },
  ];

  const raw =
    lift === undefined
      ? [from as Point, a, ...corners, c, b as Point]
      : [from as Point, a, ...detour, c, b as Point];
  const points = raw.filter((point, index) => index === 0 || !samePoint(point, raw[index - 1]));
  return { points, turn, a, c, base };
}

/**
 * A stepped line: horizontal and vertical segments only.
 *
 * Each end gets a short straight run out of its block first, so the line meets
 * the card square on rather than turning against its edge. Like the curve, it
 * routes around nothing — it is a drawing style, not a pathfinder.
 */
export function elbow(
  a: LooseFrom,
  b: EntryPoint,
  bend?: Bend | null,
  lift?: number,
): CurveGeometry {
  const from = departure(a);
  const { points, turn } = elbowPoints(from, b, bend, lift);
  return {
    path: points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
      .join(" "),
    mid: polylineMid(points),
    from,
    to: b,
    turn,
  };
}

/** Clearance kept between a line and a block it is getting past. */
const ROUTE_CLEARANCE = 22;

/**
 * How many times a detour may step further out before the side is given up on.
 *
 * Each step is measured, not guessed: it clears whatever the previous attempt
 * actually ran into. A row of equal blocks is done in one; the rest are for a
 * canvas where the way out is itself occupied, and a line that needs none of
 * them never asks for them.
 */
const ROUTE_TRIES = 6;

/**
 * Points along a path, close enough together to catch a block between them.
 *
 * Read out of the drawn path rather than recomputed from the ends, so what is
 * tested is the line that will be on screen. Recomputing was a real bug in
 * this function's first draft: it rebuilt the curve without the deflection it
 * had just been given, so every attempt to get clear measured the original
 * line and none of them ever looked like an improvement.
 */
function samplesAlong(geometry: CurveGeometry): Point[] {
  const numbers = (geometry.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: Point[] = [];

  if (!geometry.turn && numbers.length >= 8) {
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = numbers;
    for (let step = 0; step <= 48; step += 1) {
      const t = step / 48;
      const m = 1 - t;
      points.push({
        x: m * m * m * x0 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * x1,
        y: m * m * m * y0 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * y1,
      });
    }
    return points;
  }

  // A stepped line is already a polyline; fill in each run so a block sitting
  // in the middle of a long segment is not stepped over.
  const corners: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    corners.push({ x: numbers[index], y: numbers[index + 1] });
  }
  for (let index = 0; index + 1 < corners.length; index += 1) {
    const a = corners[index];
    const b = corners[index + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
    for (let step = 0; step <= steps; step += 1) {
      points.push({
        x: a.x + ((b.x - a.x) * step) / steps,
        y: a.y + ((b.y - a.y) * step) / steps,
      });
    }
  }
  return points;
}

function within(block: Rect, point: Point, pad: number): boolean {
  return (
    point.x > block.left - pad &&
    point.x < block.left + block.w + pad &&
    point.y > block.top - pad &&
    point.y < block.top + block.h + pad
  );
}

/**
 * The blocks a line passes under.
 *
 * The two it connects are not among them: the port sits `PORT_OFFSET` outside
 * its own block and the arrow lands exactly on the target's edge, so both are
 * touched by every path by construction.
 */
function crossed(
  samples: readonly Point[],
  blocks: readonly Rect[],
  from: Point,
  to: Point,
): Rect[] {
  return blocks.filter((block) => {
    if (within(block, from, PORT_OFFSET + 2) || within(block, to, 2)) return false;
    return samples.some((point) => within(block, point, 2));
  });
}

/** How tightly a curved detour turns out of the row and back into it. */
const DETOUR_RADIUS = 16;

/** Densify a polyline so a block in the middle of a long run is not stepped over. */
function along(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
    for (let step = 0; step <= steps; step += 1) {
      out.push({ x: a.x + ((b.x - a.x) * step) / steps, y: a.y + ((b.y - a.y) * step) / steps });
    }
  }
  return out;
}

/** A polyline drawn with its corners rounded off. */
function roundedPath(points: readonly Point[], radius: number): string {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const back = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const forward = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, back / 2, forward / 2);
    if (r < 0.5) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const enter = {
      x: corner.x + ((previous.x - corner.x) / back) * r,
      y: corner.y + ((previous.y - corner.y) / back) * r,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / forward) * r,
      y: corner.y + ((next.y - corner.y) / forward) * r,
    };
    path += ` L ${enter.x} ${enter.y} Q ${corner.x} ${corner.y}, ${leave.x} ${leave.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

/** The way round: out of the row, across, and back down into it. */
function detour(from: PortPoint, b: EntryPoint, y: number): Point[] {
  const out0 = OUTWARD[from.side];
  const out3 = OUTWARD[b.side];
  const a: Point = { x: from.x + out0.x * ELBOW_STUB, y: from.y + out0.y * ELBOW_STUB };
  const c: Point = { x: b.x + out3.x * ELBOW_STUB, y: b.y + out3.y * ELBOW_STUB };
  const raw = [from as Point, a, { x: a.x, y }, { x: c.x, y }, c, b as Point];
  return raw.filter((point, index) => index === 0 || !samePoint(point, raw[index - 1]));
}

/**
 * Get a line past the blocks between its ends.
 *
 * Label placement has always been block-aware — `labelSpot` steps outwards
 * until the text clears every card — while routing knew nothing about them, so
 * a connection reaching past several blocks was drawn straight through them
 * and disappeared behind each one in turn (ANT-44). On a workflow laid out in
 * one row that is every loop and every skip.
 *
 * The way round is a detour, not a wider curve. Deflecting the curve itself
 * was the first attempt and it does not work: the line is pinned in the row at
 * both ends, so clearing the block next to the one it leaves means climbing
 * forty-five pixels inside a sixty-pixel gap, and a cubic only climbs that
 * fast if its control points are flung far enough to balloon the whole line
 * into a sweep several times the size of the diagram. A detour leaves the row
 * where there is room to leave it, crosses above everything, and comes back —
 * which is exactly what the rework lines that were always readable do.
 *
 * A curved line rounds that detour's corners and a stepped one keeps them
 * square, so each stays in its own drawing language.
 *
 * This is not a pathfinder and is not meant to become one. It asks one
 * question — does this line pass under anything? — and if nothing is in the
 * way it hands back the line exactly as it was drawn before, so no connection
 * gains a detour it does not need. The author's own bend outranks it: a line
 * somebody has shaped by hand is their statement about where it should go.
 */
function clearOf(
  a: LooseFrom,
  b: EntryPoint,
  routing: Routing,
  base: CurveGeometry,
  blocks: readonly Rect[],
): CurveGeometry {
  const from = departure(a);
  const hit = crossed(samplesAlong(base), blocks, from, b);
  if (hit.length === 0) return base;

  const drawn = (points: readonly Point[]): CurveGeometry => ({
    path:
      routing === "orthogonal"
        ? points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
        : roundedPath(points, DETOUR_RADIUS),
    mid: polylineMid(points),
    from,
    to: b,
    ...(routing === "orthogonal" ? { turn: "y" as const } : {}),
  });

  const above = Math.min(...hit.map((block) => block.top));
  const below = Math.max(...hit.map((block) => block.top + block.h));
  // Whichever way out of the row is nearer to where the line already runs —
  // and then, if that way is boxed in, the other one. Committing to the nearer
  // side and never reconsidering was half of ANT-121: a line whose short way
  // out was occupied and whose long way out was clear took neither, and was
  // returned still crossing.
  const nearerIsUp = base.mid.y - above <= below - base.mid.y;

  let best = base;
  let bestCrossings = hit.length;

  for (const up of nearerIsUp ? [true, false] : [false, true]) {
    // The edge to clear, which moves as the detour meets more blocks. Stepping
    // out by fixed multiples of the clearance was the other half: the ladder
    // knew nothing about what it was climbing past, so four rungs could all
    // land inside the same tall neighbour.
    let edge = up ? above : below;
    for (let attempt = 0; attempt < ROUTE_TRIES; attempt += 1) {
      const y = up ? edge - ROUTE_CLEARANCE : edge + ROUTE_CLEARANCE;
      const points = detour(from, b, y);
      const inTheWay = crossed(along(points), blocks, from, b);
      if (inTheWay.length === 0) return drawn(points);
      if (inTheWay.length < bestCrossings) {
        best = drawn(points);
        bestCrossings = inTheWay.length;
      }
      // Past what this attempt actually met. A step that would not get further
      // than the last one is the side saying it has nothing left to offer.
      const next = up
        ? Math.min(...inTheWay.map((block) => block.top))
        : Math.max(...inTheWay.map((block) => block.top + block.h));
      if (up ? next >= edge : next <= edge) break;
      edge = next;
    }
  }
  return best;
}

/** How far a drawn line strays from the straight run between its two ends. */
function maxBow(geometry: CurveGeometry, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  let worst = 0;
  for (const point of samplesAlong(geometry)) {
    const off = Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) / length;
    if (off > worst) worst = off;
  }
  return worst;
}

/**
 * Fractions of the stored bend to try, tightest first.
 *
 * Tightest first because the smallest arch that still clears everything is the
 * one that reads as a connection rather than as a line adrift.
 */
const ARCH_STEPS = [0.3, 0.45, 0.6, 0.8];

/** Below this a bow is already modest, and worth nothing to trim. */
const ARCH_FLOOR = 60;

/**
 * Keep an arch no larger than the blocks between the ends actually require.
 *
 * A bend is stored as a fraction of the chord — `bendFromPoint` divides by the
 * chord's length and `curve` multiplies it back — which keeps a hand-dragged
 * shape stable while its blocks stay put, and makes it grow without limit when
 * they do not. `layout.ts` picks a loop's apex in absolute terms, to clear the
 * corridor by a fixed margin, and that intent is lost the moment the fraction
 * is reinterpreted against a longer chord: the arch inflates although the
 * obstacles it was avoiding have not moved.
 *
 * On the workflow this was measured against, one long skip bowed 179px off its
 * own chord — diving well below the block it was arriving at — while the two
 * connections beside it bowed 20 and 17 (ANT-53).
 *
 * So the fraction is re-fitted rather than trusted: the tightest arch that
 * crosses no more than the stored one does is the one drawn. That keeps every
 * line clear of the blocks it must get past — the fault ANT-44 fixed — while
 * refusing to arch further than getting past them requires. A line that cannot
 * be improved is returned exactly as it was, so this can only tighten, never
 * loosen, and never introduce a crossing that was not already there.
 */
function trimArch(
  a: LooseFrom,
  b: EntryPoint,
  bend: Bend,
  base: CurveGeometry,
  blocks: readonly Rect[],
): CurveGeometry {
  const from = departure(a);
  if (maxBow(base, from, b) <= ARCH_FLOOR) return base;

  const allowed = crossed(samplesAlong(base), blocks, from, b).length;
  for (const fraction of ARCH_STEPS) {
    const tried = curve(a, b, { along: bend.along, across: bend.across * fraction });
    if (crossed(samplesAlong(tried), blocks, from, b).length <= allowed) return tried;
  }
  return base;
}

/**
 * Draw a connection in whichever style it asks for.
 *
 * `blocks` is optional and is what lets the line get past what is in its way;
 * without it the geometry is exactly what it always was.
 */
export function route(
  a: LooseFrom,
  b: EntryPoint,
  options: { routing?: Routing; bend?: Bend | null; blocks?: readonly Rect[] } = {},
): CurveGeometry {
  const base =
    options.routing === "orthogonal"
      ? elbow(a, b, options.bend)
      : curve(a, b, options.bend);
  const blocks = options.blocks;
  if (hasBend(options.bend)) {
    // A stepped line has one degree of freedom and no arch to speak of, so
    // there is nothing here to trim.
    return options.routing === "orthogonal" || !blocks || blocks.length === 0
      ? base
      : trimArch(a, b, options.bend, base, blocks);
  }
  if (!blocks || blocks.length === 0) return base;
  return clearOf(a, b, options.routing ?? "curved", base, blocks);
}

/**
 * Whether a drawn line passes under a block other than the two it connects.
 *
 * The same question the router asks before detouring, for a caller choosing
 * between two landings.
 */
export function passesUnder(a: LooseFrom, b: EntryPoint, geometry: CurveGeometry, blocks: readonly Rect[]): boolean {
  return crossed(samplesAlong(geometry), blocks, departure(a), b).length > 0;
}

/**
 * A loop back along a row, drawn under it: down from the step it leaves, along
 * at `depth` below the lower of its two ends, and up into the step it returns
 * to — the shape a detour takes, so a loop reads the same wherever it runs.
 * `depth` grows for a loop that spans another, so loops nest rather than
 * cross (ANT-196).
 */
export function loopBelow(a: LooseFrom, b: EntryPoint, depth: number, routing: Routing = "curved"): CurveGeometry {
  const from = departure(a);
  const points = detour(from, b, Math.max(from.y, b.y) + depth);
  return {
    path:
      routing === "orthogonal"
        ? points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
        : roundedPath(points, DETOUR_RADIUS),
    mid: polylineMid(points),
    from,
    to: b,
    ...(routing === "orthogonal" ? { turn: "y" as const } : {}),
  };
}

export const BEND_LIMIT = 1.5;

/**
 * The bend that would put the middle of the line under a given point.
 *
 * The inverse of what `route` applies, so dragging the bend handle tracks the
 * cursor. A stepped line only has one degree of freedom — where it turns — so
 * only `along` is used there.
 */
export function bendFromPoint(
  a: LooseFrom,
  b: EntryPoint,
  routing: Routing,
  point: Point,
): Bend {
  const from = departure(a);

  if (routing === "orthogonal") {
    const { turn, a: start, c: finish, base } = elbowPoints(from, b, null);
    const span = turn === "x" ? finish.x - start.x : finish.y - start.y;
    if (Math.abs(span) < 1) return { along: 0, across: 0 };
    const at = turn === "x" ? point.x - start.x : point.y - start.y;
    return { along: clamp(at / span - base, -BEND_LIMIT, BEND_LIMIT), across: 0 };
  }

  const base = curve(from, b);
  const { u, n, length } = chordFrame(from, b);
  const offset = { x: point.x - base.mid.x, y: point.y - base.mid.y };
  return {
    along: clamp((offset.x * u.x + offset.y * u.y) / length, -BEND_LIMIT, BEND_LIMIT),
    across: clamp((offset.x * n.x + offset.y * n.y) / length, -BEND_LIMIT, BEND_LIMIT),
  };
}

/**
 * Estimated half-size of a label, from its text length.
 *
 * Measuring the real text would mean laying it out first; this approximation is
 * enough to keep labels off the blocks, which is all it is for.
 */
export function labelHalfSize(
  text: string,
  options: { quiet?: boolean; hasCondition?: boolean; condition?: string } = {},
): { halfW: number; halfH: number } {
  const quiet = options.quiet ?? false;
  const name = (quiet ? 8 : 14) + text.length * (quiet ? 3.1 : 3.5);
  // The condition is a second line under the name, in a smaller monospace
  // face, and often the longer of the two: `tester.result == "passed"` under
  // "Tests passed". Sized by the name alone, the label was placed where only
  // its middle fitted and the rest of the condition ran under the steps on
  // either side (ANT-195).
  const condition = options.condition ? 10 + options.condition.length * 3.3 : 0;
  return {
    halfW: Math.max(name, condition),
    halfH: quiet ? 11 : options.hasCondition || options.condition ? 22 : 15,
  };
}

/**
 * Where to put a label so it does not sit on top of a block.
 *
 * Starts at the middle of the curve and steps outwards along the normal to the
 * chord, preferring upwards, until the label's box is clear of every block.
 * Short connections otherwise drop their text straight onto a card.
 */
export function labelSpot(
  geometry: CurveGeometry,
  halfW: number,
  halfH: number,
  blocks: readonly Rect[],
): Point {
  const { from, to, mid } = geometry;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;

  // Normal to the chord, pointing the way the connection itself goes: up for
  // one that climbs, down for one that falls. Two connections out of a fork
  // leave from ports a few pixels apart and part at once; a normal that always
  // pointed up sent the falling one's label up onto the climbing one, so each
  // label read as the other connection's (ANT-178). A level one keeps up.
  let nx = -dy / length;
  let ny = dx / length;
  const falling = dy > length * 0.2;
  if (falling ? ny < 0 : ny > 0) {
    nx = -nx;
    ny = -ny;
  }

  const isClear = (x: number, y: number) =>
    !blocks.some(
      (block) =>
        x + halfW > block.left - LABEL_CLEARANCE &&
        x - halfW < block.left + block.w + LABEL_CLEARANCE &&
        y + halfH > block.top - LABEL_CLEARANCE &&
        y - halfH < block.top + block.h + LABEL_CLEARANCE,
    );

  /** How far the nearest block is from a candidate. Bigger is better. */
  const roominess = (x: number, y: number) =>
    Math.min(
      ...blocks.map((block) =>
        Math.max(
          block.left - LABEL_CLEARANCE - (x + halfW),
          x - halfW - (block.left + block.w + LABEL_CLEARANCE),
          block.top - LABEL_CLEARANCE - (y + halfH),
          y - halfH - (block.top + block.h + LABEL_CLEARANCE),
        ),
      ),
    );

  // The connection's own side first, at every distance, and only then the
  // other. Trying both at each distance let a clear spot a few pixels onto the
  // far side beat one a little further out on the near side — and in a tight
  // fork the far side is the neighbouring connection's, so each label read as
  // the other's (ANT-178, still seen on a three-way fork in 0.8.3 QA).
  const candidates: Point[] = [
    { x: mid.x, y: mid.y },
    ...LABEL_OFFSETS.filter((offset) => offset > 0).map((offset) => ({ x: mid.x + nx * offset, y: mid.y + ny * offset })),
    ...LABEL_OFFSETS.filter((offset) => offset > 0).map((offset) => ({ x: mid.x - nx * offset, y: mid.y - ny * offset })),
  ];

  let best = { x: mid.x, y: mid.y };
  let bestRoom = -Infinity;
  for (const spot of candidates) {
    if (isClear(spot.x, spot.y)) return spot;
    // The fallback used to be a fixed 110 above the line, returned without
    // ever being checked — and 110 sits between two offsets this search has
    // already rejected, so the one case where placement is hardest was the
    // one case that skipped the test (ANT-44). Keeping the roomiest
    // candidate instead means the answer is always one this loop looked at.
    const room = roominess(spot.x, spot.y);
    if (room > bestRoom) {
      best = spot;
      bestRoom = room;
    }
  }
  return best;
}

/** Turn a point in canvas coordinates into an anchor on a block. */
export function anchorFromPoint(rect: Rect, point: Point): AnchorPoint {
  return { u: (point.x - rect.left) / rect.w, v: (point.y - rect.top) / rect.h };
}

/** Where an unconnected output's stub ends, and where its label sits. */
export const UNCONNECTED_STUB_LENGTH = 54;
export const UNCONNECTED_LABEL_OFFSET = 88;

export function unconnectedStub(from: LooseFrom): { path: string; label: Point } {
  const out = OUTWARD[from.side ?? "right"];
  const end = {
    x: from.x + out.x * UNCONNECTED_STUB_LENGTH,
    y: from.y + out.y * UNCONNECTED_STUB_LENGTH,
  };
  return {
    path: `M ${from.x} ${from.y} L ${end.x} ${end.y}`,
    label: {
      x: from.x + out.x * UNCONNECTED_LABEL_OFFSET,
      y: from.y + out.y * UNCONNECTED_LABEL_OFFSET,
    },
  };
}
