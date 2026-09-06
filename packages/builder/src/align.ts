/**
 * Tidying up ports and arrowheads.
 *
 * Once ports can be dragged around a block and arrowheads dropped anywhere on
 * one, a diagram drifts: a port a few pixels below the middle of a side, two
 * arrows landing almost on top of each other. This puts them back on the middle
 * of whichever side they are already on — the side is the author's decision and
 * is kept; only the drift is taken out.
 *
 * Pure, and separate from the canvas, so what "centred" means is testable
 * without rendering anything.
 */

import type { EdgeAnchorPoint, Workflow } from "@anthill/workflow-schema";
import { outputsOf, patchOutput } from "@anthill/workflow";

import { PORT_SPACING, projectToSide, type Rect, type Side } from "./geometry";
import { blockRect } from "./workflow-canvas-model";

/** What a request to centre applies to. */
export type CenterScope =
  | { kind: "all" }
  | { kind: "block"; nodeId: string }
  | { kind: "output"; nodeId: string; outputId: string };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The middle of a side, with room for the others sharing it.
 *
 * Centring several ports onto the same side would otherwise stack them into one
 * point, so they are spread around the middle the same way automatic ports are.
 */
function centredAnchor(
  rect: Rect,
  side: Side,
  index: number,
  count: number,
): EdgeAnchorPoint {
  const offset = (index - (count - 1) / 2) * PORT_SPACING;
  return side === "left" || side === "right"
    ? { u: side === "left" ? 0 : 1, v: clamp01((rect.h / 2 + offset) / rect.h) }
    : { u: clamp01((rect.w / 2 + offset) / rect.w), v: side === "top" ? 0 : 1 };
}

function groupBySide<T>(items: T[], sideOf: (item: T) => Side): Map<Side, T[]> {
  const groups = new Map<Side, T[]>();
  for (const item of items) {
    const side = sideOf(item);
    groups.set(side, [...(groups.get(side) ?? []), item]);
  }
  return groups;
}

/**
 * Centre a block's own ports.
 *
 * A port on the right goes back to being automatic rather than being pinned to
 * the middle: the automatic placement *is* centred on the right edge, and
 * leaving it automatic means later outputs keep sharing the edge evenly.
 */
function centerPorts(workflow: Workflow, nodeId: string): Workflow {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node) return workflow;

  const rect = blockRect(node);
  const placed = outputsOf(workflow, nodeId).filter((output) => output.port);
  if (placed.length === 0) return workflow;

  let next = workflow;
  for (const [side, group] of groupBySide(placed, (output) =>
    projectToSide(rect, output.port!).side,
  )) {
    group.forEach((output, index) => {
      next = patchOutput(next, nodeId, output.id, {
        port: side === "right" ? null : centredAnchor(rect, side, index, group.length),
      });
    });
  }
  return next;
}

/** Centre the arrowheads landing on a block. */
function centerLandings(workflow: Workflow, nodeId: string): Workflow {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node) return workflow;

  const rect = blockRect(node);
  const landings = workflow.edges.filter(
    (edge) => edge.target === nodeId && edge.anchor,
  );
  if (landings.length === 0) return workflow;

  let next = workflow;
  for (const [side, group] of groupBySide(landings, (edge) =>
    projectToSide(rect, edge.anchor!).side,
  )) {
    group.forEach((edge, index) => {
      next = patchOutput(next, edge.source, edge.id, {
        anchor: centredAnchor(rect, side, index, group.length),
      });
    });
  }
  return next;
}

/** Which blocks a scope resolves to. Always whole blocks, so no group is
 *  half-tidied and left overlapping. */
function blocksInScope(workflow: Workflow, scope: CenterScope): string[] {
  if (scope.kind === "all") return workflow.nodes.map((node) => node.id);
  if (scope.kind === "block") return [scope.nodeId];

  const edge = workflow.edges.find(
    (item) => item.id === scope.outputId && item.source === scope.nodeId,
  );
  return edge ? [...new Set([edge.source, edge.target])] : [scope.nodeId];
}

/**
 * Put ports and arrowheads back on the middle of the sides they sit on.
 *
 * Returns the workflow unchanged when there was nothing out of place, so tidying an
 * already-tidy diagram does not mark it as edited.
 */
export function centerOutputs(workflow: Workflow, scope: CenterScope): Workflow {
  let next = workflow;
  for (const nodeId of blocksInScope(workflow, scope)) {
    next = centerLandings(centerPorts(next, nodeId), nodeId);
  }
  return next;
}
