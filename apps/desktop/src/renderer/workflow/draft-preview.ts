/**
 * The geometry of the graph that draws itself while a draft is being made.
 *
 * This is a preview, not the draft: nothing has been proposed yet, and drawing
 * a real graph before a validated draft exists would claim Anthill had
 * recognised blocks it has not. What it shows is the canvas's own vocabulary —
 * a Start pill, blocks with their category rules, a next edge, a rework return,
 * a question path — so a minute of waiting looks like the thing being built.
 *
 * It lives here, apart from the component, because of the bug that produced it.
 * The blocks were HTML elements positioned in CSS pixels and the edges were SVG
 * path data typed by hand, so the two had to be kept in agreement by arithmetic
 * nobody re-did after the layout moved. They fell out of agreement: three of
 * the five edges ended in empty space — one 34px past the block it pointed at,
 * two several pixels above and below blocks entirely — and none had an
 * arrowhead. An edge here can no longer land anywhere but on a port, because it
 * is not given a destination, only a block and a side.
 */

export type PreviewNodeId = "n1" | "n2" | "n3" | "n4" | "n5";

/** Which category rule a block wears. Purely the canvas's colour vocabulary. */
export type PreviewTone = "plain" | "build" | "verify" | "question";

export type PreviewNode = {
  id: PreviewNodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: PreviewTone;
  /** A pill is a control block: Start, or a question. */
  pill?: boolean;
  /** When it appears, in seconds into the loop. */
  delay: number;
};

/** The four sides a connection may leave from or arrive at. */
export type Side = "left" | "right" | "top" | "bottom";

export type PreviewEdge = {
  id: string;
  from: PreviewNodeId;
  fromSide: Side;
  to: PreviewNodeId;
  toSide: Side;
  tone: "next" | "rework" | "question";
  delay: number;
};

export const PREVIEW_SIZE = { width: 560, height: 250 } as const;

export const PREVIEW_NODES: PreviewNode[] = [
  { id: "n1", x: 38, y: 112, w: 80, h: 26, tone: "plain", pill: true, delay: 0 },
  { id: "n2", x: 190, y: 98, w: 116, h: 54, tone: "build", delay: 0.5 },
  { id: "n3", x: 378, y: 98, w: 116, h: 54, tone: "verify", delay: 1.1 },
  { id: "n4", x: 378, y: 178, w: 116, h: 48, tone: "build", delay: 1.9 },
  { id: "n5", x: 350, y: 30, w: 96, h: 26, tone: "question", pill: true, delay: 2.6 },
];

/**
 * Every edge appears after the block it points at.
 *
 * The old sequence drew the first edge two tenths of a second before the block
 * it arrived at existed, which is the same dangling fragment as a wrong
 * coordinate, arrived at through time instead of space.
 */
export const PREVIEW_EDGES: PreviewEdge[] = [
  { id: "e1", from: "n1", fromSide: "right", to: "n2", toSide: "left", tone: "next", delay: 0.7 },
  { id: "e2", from: "n2", fromSide: "right", to: "n3", toSide: "left", tone: "next", delay: 1.3 },
  { id: "e3", from: "n3", fromSide: "bottom", to: "n4", toSide: "top", tone: "next", delay: 2.1 },
  {
    id: "e4",
    from: "n4",
    fromSide: "left",
    to: "n2",
    toSide: "bottom",
    tone: "rework",
    delay: 2.4,
  },
  {
    id: "e5",
    from: "n2",
    fromSide: "top",
    to: "n5",
    toSide: "left",
    tone: "question",
    delay: 2.8,
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

function control(at: Point, side: Side, reach = REACH): Point {
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
 */
export function previewPath(edge: PreviewEdge): string {
  const from = port(nodeById(edge.from), edge.fromSide);
  const to = port(nodeById(edge.to), edge.toSide);
  // A rework return has to get out from under the block it leaves and travel
  // back across the diagram, so it reaches further before it turns.
  const reach = edge.tone === "rework" ? 74 : REACH;
  const c1 = control(from, edge.fromSide, reach);
  const c2 = control(to, edge.toSide, reach);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** Both endpoints, for anything that needs to check where an edge landed. */
export function previewEnds(edge: PreviewEdge): { from: Point; to: Point } {
  return {
    from: port(nodeById(edge.from), edge.fromSide),
    to: port(nodeById(edge.to), edge.toSide),
  };
}
