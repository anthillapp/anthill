/**
 * Where a workflow's blocks are drawn when the workflow does not say.
 *
 * A revision handed over by a harness carries no positions — the model proposed
 * a shape, not a picture — and the revision is immutable, so the drawing can
 * never be written back into it. The view has to supply the missing
 * coordinates, and supply them again on every render.
 *
 * Deriving them from the graph each time is what `layoutWorkflow` does, and on
 * its own that is wrong: the layout of four blocks is not the layout of the
 * same four with a fifth added, so adding one block moved every block already
 * on screen. The *positions* are therefore what is remembered, not the laid-out
 * workflow. A block goes through the layout once, the first time it is drawn,
 * and keeps the place it was given for as long as the document is on screen.
 * Both things then hold at once: the revision is untouched, and nothing moves
 * because something unrelated to it changed.
 *
 * The memory belongs to whoever is drawing — `useDisplayLayout` holds one per
 * canvas — so two documents that name a block the same cannot inherit each
 * other's drawing.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { layoutWorkflow } from "./layout";
import { blockSize } from "./workflow-canvas-model";
import type { Point } from "./geometry";

/**
 * Space between the drawing and the band a later block is placed in.
 *
 * One column gap, so a block that arrives after the others reads as the next
 * column rather than as part of the last one.
 */
const BAND_GAP = 132;

/**
 * Give every block a position: its own, the one it was drawn at, or a new one.
 *
 * `remembered` is both where placements are read from and where they are kept:
 * a block already in it is drawn where it was drawn before, whatever the graph
 * has become since, and only the blocks missing from it go through the layout.
 * Called without one — a single drawing of a workflow, rather than a surface
 * that will render again — every position-less block is placed afresh.
 */
export function withDisplayLayout(workflow: Workflow, remembered?: Map<string, Point>): Workflow {
  if (workflow.nodes.every((node) => node.position)) return workflow;

  const drawn = remembered ?? new Map<string, Point>();
  const unplaced = workflow.nodes.filter((node) => !node.position && !drawn.has(node.id));

  if (unplaced.length > 0) {
    // Remembered positions count towards the band as well as authored ones: a
    // block added later has to land beside the drawing as it stands, and most
    // of a handover's drawing is never authored at all.
    const rightEdges = workflow.nodes.flatMap((node) => {
      const at = node.position ?? drawn.get(node.id);
      return at ? [at.x + blockSize(node).w] : [];
    });
    const offset = rightEdges.length === 0 ? 0 : Math.max(...rightEdges) + BAND_GAP;

    const fresh = layoutWorkflow(workflow);
    for (const node of unplaced) {
      const at = fresh.get(node.id);
      if (at) drawn.set(node.id, { x: at.x + offset, y: at.y });
    }
  }

  // Keep every authored position, and the node object carrying it: a block the
  // author placed is not this module's business.
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const at = drawn.get(node.id);
      return node.position || !at ? node : { ...node, position: at };
    }),
  };
}
