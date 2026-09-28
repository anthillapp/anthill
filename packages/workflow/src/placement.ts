/**
 * Where a block added without a place of its own goes on the canvas.
 *
 * A library click adds a block with no drop point, and it used to land at a
 * spot worked out from how many blocks there were — the same few spots over
 * and over, on top of the blocks already there and across the Start → Done
 * connection of a blank canvas (ANT-183). The author then had to drag every
 * one apart before anything could be read or wired.
 */

import type { WorkflowNode } from "@anthill/workflow-schema";

/** A step card's width, as `edit-proposal.ts` keeps it; see there. */
const BLOCK_W = 196;
const GAP = 40;
/** Enough to clear a tall block. */
const ROW = 130;

function clashes(spot: { x: number; y: number }, nodes: readonly WorkflowNode[]): boolean {
  return nodes.some((node) => {
    const at = node.position;
    if (!at) return false;
    return Math.abs(at.x - spot.x) < BLOCK_W + GAP / 2 && Math.abs(at.y - spot.y) < ROW;
  });
}

/**
 * The first free spot in the rows under the workflow's top row, left to right.
 *
 * Not in the top row: that is where Start is and the workflow's own
 * connections run, so a block there sits on a line. Successive additions fill
 * a row rightward, then start the next one down.
 */
export function openSpot(nodes: readonly WorkflowNode[]): { x: number; y: number } {
  const placed = nodes.filter((node) => node.position);
  if (placed.length === 0) return { x: 120, y: 160 };
  const left = Math.min(...placed.map((node) => node.position!.x));
  const top = Math.min(...placed.map((node) => node.position!.y));
  for (let row = 1; row < 200; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const spot = { x: left + column * (BLOCK_W + GAP), y: top + row * ROW };
      if (!clashes(spot, placed)) return spot;
    }
  }
  const bottom = Math.max(...placed.map((node) => node.position!.y));
  return { x: left, y: bottom + ROW };
}
