/**
 * Where a block added without a place of its own goes on the canvas.
 *
 * A library click adds a block with no drop point, and it used to land at a
 * spot worked out from how many blocks there were — the same few spots over
 * and over, on top of the blocks already there and across the Start → Done
 * connection of a blank canvas (ANT-183). The author then had to drag every
 * one apart before anything could be read or wired.
 *
 * A block is not only its card: an output with nowhere to go yet is drawn as
 * a dashed stub with "not connected" beside it, reaching well past the card's
 * edge. A block placed in the next column over sat on those stubs (ANT-205),
 * so they are kept clear too — other blocks' stubs, and the new block's own.
 */

import type { WorkflowNode } from "@anthill/workflow-schema";

/** A step card's width, as `edit-proposal.ts` keeps it; see there. */
const BLOCK_W = 196;
const GAP = 40;
/** Enough to clear a tall block. */
const ROW = 130;
/**
 * How far past its card an unconnected output reaches: the canvas puts the
 * "not connected" label 88 units out from the port (`UNCONNECTED_LABEL_OFFSET`
 * in the builder), centred, so its far end is a little further still.
 */
const STUB_REACH = 140;

type Side = "left" | "right" | "top" | "bottom";
type Reach = Record<Side, number>;

const NO_REACH: Reach = { left: 0, right: 0, top: 0, bottom: 0 };

function sideOfPort(port: unknown): Side {
  if (typeof port !== "object" || port === null) return "right";
  const { u, v } = port as { u?: unknown; v?: unknown };
  if (typeof u !== "number" || typeof v !== "number") return "right";
  if (u <= 0.01) return "left";
  if (v <= 0.01) return "top";
  if (v >= 0.99) return "bottom";
  return "right";
}

/** How far a block's unconnected outputs reach out of it, side by side. */
function reachOf(node: WorkflowNode): Reach {
  const pending = node.config?.pendingOutputs;
  if (!Array.isArray(pending) || pending.length === 0) return NO_REACH;
  const reach = { ...NO_REACH };
  for (const item of pending) {
    const port = typeof item === "object" && item !== null ? (item as { port?: unknown }).port : undefined;
    reach[sideOfPort(port)] = STUB_REACH;
  }
  return reach;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxAt(at: { x: number; y: number }, reach: Reach): Box {
  // Half the gap on each side of every block, so two of them are a gap apart.
  return {
    left: at.x - GAP / 4 - reach.left,
    right: at.x + BLOCK_W + GAP / 4 + reach.right,
    top: at.y - ROW / 2 - reach.top,
    bottom: at.y + ROW / 2 + reach.bottom,
  };
}

function overlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function clashes(spot: Box, nodes: readonly WorkflowNode[]): boolean {
  return nodes.some((node) => node.position && overlap(spot, boxAt(node.position, reachOf(node))));
}

export interface OpenSpotOptions {
  /**
   * Whether the block being placed will have outputs with nowhere to go yet,
   * as every library block but End does. Its stubs then need the room too.
   */
  unconnectedOutputs?: boolean;
}

/**
 * The first free spot in the rows under the workflow's top row, left to right.
 *
 * Not in the top row: that is where Start is and the workflow's own
 * connections run, so a block there sits on a line. Successive additions fill
 * a row rightward, then start the next one down.
 */
export function openSpot(
  nodes: readonly WorkflowNode[],
  options: OpenSpotOptions = {},
): { x: number; y: number } {
  const placed = nodes.filter((node) => node.position);
  if (placed.length === 0) return { x: 120, y: 160 };
  const own: Reach = options.unconnectedOutputs ? { ...NO_REACH, right: STUB_REACH } : NO_REACH;
  const left = Math.min(...placed.map((node) => node.position!.x));
  const top = Math.min(...placed.map((node) => node.position!.y));
  for (let row = 1; row < 200; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const spot = { x: left + column * (BLOCK_W + GAP), y: top + row * ROW };
      if (!clashes(boxAt(spot, own), placed)) return spot;
    }
  }
  const bottom = Math.max(...placed.map((node) => node.position!.y));
  return { x: left, y: bottom + ROW };
}
