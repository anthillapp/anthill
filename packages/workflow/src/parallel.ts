/**
 * Which parts of a workflow run side by side (ANT-166).
 *
 * The diagram lets an author draw several connections out of one block, and
 * one reading is the obvious one: both branches get done. The compiled prompt
 * said otherwise — a list numbered 1, 2, 3 out of Start, "otherwise …
 * otherwise …" out of a step — and nothing said where the branches meet
 * again. This is the one place that decides it:
 *
 * - A block whose outgoing connections are all plain (`next`) and carry no
 *   condition, and there are at least two of them, is a **fork**: every
 *   branch starts at once. Connections with a condition — rework among them —
 *   are a choice of exactly one path, as they always were.
 * - A block where branches of one fork meet again is a **join**: it starts
 *   only once every one of those branches has reached it. Branches that meet
 *   after a *choice* are not a join; the path not taken is never coming.
 *
 * Rework and any connection back to an earlier block are loops within a
 * branch, not branches of their own, so they are left out of both.
 */

import type { Workflow, WorkflowEdge } from "@anthill/workflow-schema";

export type ParallelPlan = {
  /** Fork block id → the blocks its branches start at, in the document's order. */
  forks: Map<string, string[]>;
  /** Join block id → the blocks, one per branch, it waits for. */
  joins: Map<string, string[]>;
  /** Whether two blocks are on different branches of one fork, before they meet. */
  parallel(a: string, b: string): boolean;
};

const isPlain = (edge: WorkflowEdge) =>
  (edge.kind === undefined || edge.kind === "next") && !edge.condition?.trim();

export function parallelPlan(workflow: Workflow): ParallelPlan {
  const out = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) out.set(edge.source, [...(out.get(edge.source) ?? []), edge]);

  // Connections that go back: rework by name, and any edge closing a cycle
  // on a walk from the start. What is left is the forward flow.
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const walk = (id: string) => {
    state.set(id, "open");
    for (const edge of out.get(id) ?? []) {
      if (edge.kind === "rework" || state.get(edge.target) === "open") {
        back.add(edge.id);
        continue;
      }
      if (!state.has(edge.target)) walk(edge.target);
    }
    state.set(id, "done");
  };
  for (const node of workflow.nodes) if (node.type === "start") walk(node.id);
  for (const node of workflow.nodes) if (!state.has(node.id)) walk(node.id);
  const forward = (id: string) => (out.get(id) ?? []).filter((edge) => !back.has(edge.id));

  const reach = (from: string): Set<string> => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const edge of forward(id)) {
        if (!seen.has(edge.target)) {
          seen.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    return seen;
  };

  const forks = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    // A person's answer picks one way out of an Approval Gate: its paths are
    // alternatives however they are drawn, never branches to run at once.
    // Read as a fork, a gate with "approved" and "declined" compiled into both
    // branches at the same time, writing the same file (ANT-187).
    if (node.type === "condition" || node.type === "end" || node.type === "approval") continue;
    const edges = out.get(node.id) ?? [];
    if (edges.length >= 2 && edges.every(isPlain)) forks.set(node.id, edges.map((edge) => edge.target));
  }

  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (back.has(edge.id)) continue;
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }

  const joins = new Map<string, string[]>();
  for (const targets of forks.values()) {
    const branches = targets.map(reach);
    const branchesOf = (id: string) => branches.flatMap((set, index) => (set.has(id) ? [index] : []));
    for (const [id, sources] of incoming) {
      // Sources on this fork's branches, and which branch each is on.
      const onBranches = sources
        .map((source) => ({ source, on: branchesOf(source) }))
        .filter(({ on }) => on.length > 0);
      const distinct = new Set(onBranches.flatMap(({ on }) => (on.length === 1 ? on : [])));
      if (distinct.size < 2) continue;
      const waits = [...new Set([...(joins.get(id) ?? []), ...onBranches.map(({ source }) => source)])];
      joins.set(id, waits);
    }
  }

  /*
    What `parallel` asks of: each branch as a region, from where it starts up
    to (not into) the join, following every connection — so a step reached
    only by a rework loop inside the branch still belongs to it — but never
    back into the fork itself.
  */
  const regions: Set<string>[][] = [];
  for (const [fork, targets] of forks) {
    const stops = new Set<string>([fork, ...joins.keys()]);
    regions.push(
      targets.map((start) => {
        const seen = new Set<string>([start]);
        const queue = [start];
        while (queue.length > 0) {
          const id = queue.shift() as string;
          for (const edge of out.get(id) ?? []) {
            if (stops.has(edge.target) || seen.has(edge.target)) continue;
            seen.add(edge.target);
            queue.push(edge.target);
          }
        }
        return seen;
      }),
    );
  }

  const parallel = (a: string, b: string) =>
    a !== b &&
    regions.some((branches) =>
      branches.some(
        (mine, i) =>
          mine.has(a) &&
          !mine.has(b) &&
          branches.some((theirs, j) => j !== i && theirs.has(b) && !theirs.has(a)),
      ),
    );

  return { forks, joins, parallel };
}
