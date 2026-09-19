import type { Workflow } from "@anthill/workflow-schema";
import { layoutWorkflow } from "./layout";
import { blockRect } from "./workflow-canvas-model";

/** Position-less handovers need a view, not a rewrite of their revision. */
export function withDisplayLayout(workflow: Workflow): Workflow {
  const missing = workflow.nodes.filter((node) => !node.position);
  if (missing.length === 0) return workflow;
  const placed = workflow.nodes.filter((node) => node.position);
  const positions = layoutWorkflow(workflow);
  // Keep every authored position. New blocks occupy a separate band to its
  // right; displaying an incomplete layout must never move existing blocks.
  const offset = placed.length === 0 ? 0 : Math.max(...placed.map((node) => {
    const rect = blockRect(node);
    return rect.left + rect.w;
  })) + 132;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const position = positions.get(node.id);
      return node.position || !position ? node : { ...node, position: { x: position.x + offset, y: position.y } };
    }),
  };
}
