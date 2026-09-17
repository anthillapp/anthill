/**
 * The geometry of the graph that draws itself while a draft is being made.
 *
 * This is a preview, not the draft: nothing has been proposed yet, and drawing
 * a real graph before a validated draft exists would claim Anthill had
 * recognised blocks it has not. What it shows is the canvas's own vocabulary —
 * a Start pill, blocks in the anatomy of a real one, a next edge, a rework
 * return, a question path — so a minute of waiting looks like the thing being
 * built.
 *
 * It lives here, apart from the component, because of the bug that produced it.
 * The blocks were HTML elements positioned in CSS pixels and the edges were SVG
 * path data typed by hand, so the two had to be kept in agreement by arithmetic
 * nobody re-did after the layout moved. They fell out of agreement: three of
 * the five edges ended in empty space — one 34px past the block it pointed at,
 * two several pixels above and below blocks entirely — and none had an
 * arrowhead. An edge here can no longer land anywhere but on a port, because it
 * is not given a destination, only a block and a side. The blocks are HTML
 * again — a skeleton bar needs a CSS gradient, which an SVG rect cannot carry —
 * but both are placed from this one table, so there is nothing to keep in
 * agreement by hand.
 */

export type PreviewNodeId = "n1" | "n2" | "n3" | "n4" | "n5";

/** Which category dot a block wears. Purely the canvas's colour vocabulary. */
export type PreviewTone = "build" | "verify";

/**
 * A skeleton bar, in CSS pixels.
 *
 * An empty white card reads as a broken placeholder; a shimmering bar reads as
 * a value being written. That is the entire reason these exist.
 */
export type Bar = { w: number; h: number };

/**
 * The unwritten lines inside one step card.
 *
 * The three cards differ on purpose — different bar widths, and two chips
 * against one. Three identical cards read as three copies of one placeholder;
 * varied ones read as three different steps.
 */
export type Skeleton = {
  /** The action, on the header row beside the category dot. */
  action: Bar;
  /** The pass counter at the right end of the header row. */
  index: Bar;
  /** The block's name. */
  title: Bar;
  /** The agent and its model, along the bottom. */
  chips: Bar[];
};

/**
 * A block in the preview.
 *
 * `start` and `done` carry their real names: they are not being decided by the
 * interpreter, so hiding them behind a skeleton would be a small lie.
 * Everything the interpreter *is* deciding — action, name, agent, passes — is
 * an unwritten line on a `step`.
 */
export type PreviewNode = {
  id: PreviewNodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** When it appears, in seconds into the loop. */
  delay: number;
} & (
  | { kind: "start" | "done" }
  | { kind: "step"; tone: PreviewTone; skeleton: Skeleton }
);

/** The four sides a connection may leave from or arrive at. */
export type Side = "left" | "right" | "top" | "bottom";

/**
 * How a connection is stroked.
 *
 * `dashed` and `dotted` cannot be drawn by `stroke-dashoffset` — the pattern
 * *is* the dasharray, and overwriting it to draw the line would flatten the
 * dashes and lose the meaning the dash carries. Those two fade in instead; the
 * component reads this to decide which animation a connection gets.
 */
export type Stroke = "solid" | "dashed" | "dotted";

export type PreviewEdge = {
  id: string;
  from: PreviewNodeId;
  fromSide: Side;
  to: PreviewNodeId;
  toSide: Side;
  tone: "next" | "rework" | "question";
  stroke: Stroke;
  delay: number;
  /** How far the curve leaves each side before it bends, when not the default. */
  fromReach?: number;
  toReach?: number;
};

export const PREVIEW_SIZE = { width: 560, height: 250 } as const;

/**
 * When ink actually appears, as a fraction of the loop.
 *
 * These mirror the keyframes in `styles.css` — `node-in`, `edge-in` and
 * `edge-fade` all hold at zero opacity for the first slice of their cycle, so a
 * delay is not the moment a thing is seen. Kept here because the ordering rule
 * below is stated in terms of them, and a test can only check what it can read.
 */
export const LOOP_SECONDS = 5.2;
/** `node-in`: invisible until 4%, fully there at 14%. */
export const NODE_VISIBLE_AT = 0.14;
/** `edge-in`: nothing until 8%, fully drawn at 34%. `edge-fade` is up at 26%. */
export const EDGE_DRAWN_AT = 0.34;
export const EDGE_FADED_AT = 0.26;

/**
 * The five blocks, in reading order.
 *
 * Hand-placed, and they have to be: there is no layout engine here and there
 * should not be one, because nothing in this panel is derived from the draft in
 * flight. Positions and sizes are the handoff's own, in the panel's 560×250
 * space, which the SVG shares as its `viewBox`.
 */
export const PREVIEW_NODES: PreviewNode[] = [
  { id: "n1", kind: "start", x: 24, y: 110, w: 82, h: 30, delay: 0 },
  {
    id: "n2",
    kind: "step",
    tone: "build",
    x: 146,
    y: 92,
    w: 132,
    h: 66,
    delay: 0.5,
    skeleton: {
      action: { w: 52, h: 5 },
      index: { w: 9, h: 5 },
      title: { w: 78, h: 11 },
      chips: [
        { w: 44, h: 13 },
        { w: 22, h: 13 },
      ],
    },
  },
  {
    id: "n3",
    kind: "step",
    tone: "verify",
    x: 330,
    y: 92,
    w: 132,
    h: 66,
    delay: 1.1,
    skeleton: {
      action: { w: 46, h: 5 },
      index: { w: 9, h: 5 },
      title: { w: 64, h: 11 },
      chips: [
        { w: 38, h: 13 },
        { w: 26, h: 13 },
      ],
    },
  },
  {
    id: "n4",
    kind: "step",
    tone: "build",
    x: 330,
    y: 178,
    w: 132,
    h: 66,
    delay: 1.9,
    skeleton: {
      action: { w: 50, h: 5 },
      index: { w: 9, h: 5 },
      title: { w: 70, h: 11 },
      chips: [{ w: 44, h: 13 }],
    },
  },
  { id: "n5", kind: "done", x: 322, y: 32, w: 100, h: 30, delay: 2.6 },
];

/**
 * The five connections.
 *
 * Nodes land in reading order; each edge is drawn around the block it points
 * at; the two conditional ones arrive last, so the loop and the question read
 * as *additions* to a sequence — which is how an author actually builds one.
 *
 * A connection may begin to draw fractionally before its block has faded in:
 * the line takes more than a second to cross, and what must not happen is an
 * arrowhead waiting at a block nobody can see. That is the property the tests
 * hold, and it is stated in ink rather than in delays.
 */
export const PREVIEW_EDGES: PreviewEdge[] = [
  {
    id: "e1",
    from: "n1",
    fromSide: "right",
    to: "n2",
    toSide: "left",
    tone: "next",
    stroke: "solid",
    delay: 0.3,
  },
  {
    id: "e2",
    from: "n2",
    fromSide: "right",
    to: "n3",
    toSide: "left",
    tone: "next",
    stroke: "solid",
    delay: 0.9,
  },
  {
    id: "e3",
    from: "n3",
    fromSide: "bottom",
    to: "n4",
    toSide: "top",
    tone: "rework",
    stroke: "solid",
    delay: 1.5,
  },
  {
    id: "e4",
    from: "n4",
    fromSide: "left",
    to: "n2",
    toSide: "bottom",
    tone: "next",
    stroke: "dashed",
    delay: 2.1,
    // It has to get out from under the block it leaves and travel back across
    // the diagram, so it reaches further before it turns.
    fromReach: 44,
    toReach: 48,
  },
  {
    id: "e5",
    from: "n2",
    fromSide: "top",
    to: "n5",
    toSide: "left",
    tone: "question",
    stroke: "dotted",
    delay: 2.8,
    toReach: 72,
  },
];

export type Point = { x: number; y: number };

/** The middle of one side of a block. The only place an edge may touch it. */
export function port(node: PreviewNode, side: Side): Point {
  switch (side) {
    case "left":
      return { x: node.x, y: node.y + node.h / 2 };
    case "right":
      return { x: node.x + node.w, y: node.y + node.h / 2 };
    case "top":
      return { x: node.x + node.w / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.w / 2, y: node.y + node.h };
  }
}

function nodeById(id: PreviewNodeId): PreviewNode {
  const found = PREVIEW_NODES.find((node) => node.id === id);
  if (!found) throw new Error(`no preview block ${id}`);
  return found;
}

/** How far a curve leaves a side before it starts bending. */
const REACH = 34;

function control(at: Point, side: Side, reach: number): Point {
  switch (side) {
    case "left":
      return { x: at.x - reach, y: at.y };
    case "right":
      return { x: at.x + reach, y: at.y };
    case "top":
      return { x: at.x, y: at.y - reach };
    case "bottom":
      return { x: at.x, y: at.y + reach };
  }
}

/**
 * The path for one edge, from its two ports outwards.
 *
 * A cubic whose handles leave each block along the side's own normal, so a
 * connection always departs and arrives square to the block rather than
 * cutting across a corner — and the arrowhead, which orients itself on the
 * final segment, points the way the flow goes.
 *
 * The handles are also kept shorter than half the distance they span. A default
 * reach on the 20px hop between the two stacked blocks put the two control
 * points the wrong side of each other, and the line drew itself backwards
 * before settling — on a straight segment nobody would think to check.
 */
export function previewPath(edge: PreviewEdge): string {
  const from = port(nodeById(edge.from), edge.fromSide);
  const to = port(nodeById(edge.to), edge.toSide);
  const span = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  const cap = (reach: number) => Math.min(reach, span * 0.45);
  const c1 = control(from, edge.fromSide, cap(edge.fromReach ?? REACH));
  const c2 = control(to, edge.toSide, cap(edge.toReach ?? REACH));
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** Both endpoints, for anything that needs to check where an edge landed. */
export function previewEnds(edge: PreviewEdge): { from: Point; to: Point } {
  return {
    from: port(nodeById(edge.from), edge.fromSide),
    to: port(nodeById(edge.to), edge.toSide),
  };
}
