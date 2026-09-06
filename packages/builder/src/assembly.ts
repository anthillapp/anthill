/**
 * The order in which a drafted workflow assembles on the canvas.
 *
 * When a validated draft becomes the open workflow, the graph does not blink
 * into place; it builds, in the order the draft was reasoned about: Start
 * first — the stand-in for the shared context every step inherits — then the
 * blocks, walking outward from Start, then the connections. A connection never
 * appears before both of its endpoints, because a line to a block that is not
 * there yet is a claim about nothing.
 *
 * This file is only the *timing*. The geometry is laid out before the first
 * frame and never changes during the reveal — an assembly that moved things
 * while showing them would trade one kind of confusion for another. And it is
 * only ever timing for a freshly accepted draft: reopening a saved workflow, or
 * editing one, draws everything at once.
 */

import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";

export type AssemblyPlan = {
  /** Seconds until each block appears, by node id. */
  blocks: Map<string, number>;
  /** Seconds until each connection appears, by edge id. */
  edges: Map<string, number>;
  /** When the last element has appeared, in seconds. */
  total: number;
};

/** The pause between one element appearing and the next. */
const STEP_S = 0.14;
/** The pause between the last block and the first connection. */
const EDGE_GAP_S = 0.24;

/**
 * Blocks in the order the workflow reads: breadth-first from every start
 * block, so the reveal walks the way control will flow. Anything unreachable
 * comes last, in document order — it still exists and must still appear.
 */
function blockOrder(workflow: Workflow): WorkflowNode[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const next = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  }

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  const queue = workflow.nodes.filter((node) => node.type === "start").map((node) => node.id);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const target of next.get(id) ?? []) queue.push(target);
  }

  for (const node of workflow.nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

export function assemblyPlan(workflow: Workflow): AssemblyPlan {
  const blocks = new Map<string, number>();
  blockOrder(workflow).forEach((node, index) => {
    blocks.set(node.id, index * STEP_S);
  });

  const lastBlock = Math.max(0, ...blocks.values());

  /*
    Connections, each strictly after both of its endpoints.

    They are sorted by when their later endpoint appeared, so the reveal keeps
    moving forward through the graph rather than jumping back — and a loop's
    return edge, whose later endpoint is late, naturally comes near the end,
    which is also where it belongs in the story the order tells.
  */
  const edges = new Map<string, number>();
  const ready = workflow.edges
    .map((edge) => ({
      id: edge.id,
      after: Math.max(blocks.get(edge.source) ?? 0, blocks.get(edge.target) ?? 0),
    }))
    .sort((a, b) => a.after - b.after || a.id.localeCompare(b.id));

  ready.forEach((edge, index) => {
    edges.set(edge.id, Math.max(lastBlock + EDGE_GAP_S, edge.after + EDGE_GAP_S) + index * STEP_S);
  });

  const total = Math.max(lastBlock, ...edges.values()) + STEP_S;
  return { blocks, edges, total };
}
