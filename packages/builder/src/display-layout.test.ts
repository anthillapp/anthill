import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { withDisplayLayout } from "./display-layout";
import type { Point } from "./geometry";
import { blockRect } from "./workflow-canvas-model";

function workflow(): Workflow {
  return {
    id: "handover", name: "Handover", version: "1",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "read", type: "agent", name: "Read", config: {} },
      { id: "end", type: "end", name: "End", config: {} },
    ],
    edges: [{ id: "a", source: "start", target: "read" }, { id: "b", source: "read", target: "end" }],
  };
}

describe("displaying handovers without positions", () => {
  it("lays out a directed graph without mutating the immutable source", () => {
    const source = workflow();
    const before = JSON.stringify(source);
    const view = withDisplayLayout(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(view.edges).toBe(source.edges);
    const xs = view.nodes.map((node) => node.position!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(withDisplayLayout(source)).toEqual(view);
  });

  it("preserves manual positions and leaves space for missing blocks", () => {
    const source = workflow();
    source.nodes[0].position = { x: 1000, y: -500 };
    const view = withDisplayLayout(source);
    expect(view.nodes[0]).toBe(source.nodes[0]);
    expect(view.nodes[1].position!.x).toBeGreaterThan(1240);
    expect(withDisplayLayout(view)).toBe(view);
  });
});

describe("remembering where a handover was drawn", () => {
  /** The same handover with one more step hung off the middle of it. */
  function grown(): Workflow {
    const next = workflow();
    next.nodes.push({ id: "check", type: "agent", name: "Check", config: {} });
    next.edges.push({ id: "c", source: "read", target: "check" });
    return next;
  }

  /**
   * A drawing nobody has touched is laid out again from the graph (ANT-117).
   *
   * Keeping every block where it was is right when the author put it there.
   * When they did not — a handover carries no positions, and every coordinate
   * came from this module — it costs the drawing its meaning: the added block
   * landed past the end block, so the edge into `end` ran right to left and
   * passed underneath it.
   */
  it("lays an untouched drawing out again, so the graph and the picture agree", () => {
    const drawn = new Map<string, Point>();
    withDisplayLayout(workflow(), drawn);
    const after = withDisplayLayout(grown(), drawn);

    const x = (id: string) => after.nodes.find((node) => node.id === id)?.position?.x ?? 0;
    // `end` is last in the graph, so it is last on the canvas.
    expect(x("end")).toBeGreaterThan(x("check"));
    expect(x("check")).toBeGreaterThan(x("read"));
    expect(x("read")).toBeGreaterThan(x("start"));
  });

  it("leaves a block where it was once the author has placed anything", () => {
    const drawn = new Map<string, Point>();
    const placed = () => {
      const next = grown();
      // One authored position is enough: the arrangement is now theirs.
      next.nodes[0].position = { x: 0, y: 0 };
      return next;
    };
    const first = withDisplayLayout(placed(), drawn);
    const after = withDisplayLayout(placed(), drawn);

    for (const node of first.nodes) {
      expect(after.nodes.find((item) => item.id === node.id)?.position).toEqual(node.position);
    }
  });

  it("places a block added later clear of the ones already drawn", () => {
    const drawn = new Map<string, Point>();
    const authored = () => {
      const next = workflow();
      next.nodes[0].position = { x: 0, y: 0 };
      return next;
    };
    const before = withDisplayLayout(authored(), drawn);
    const grownAuthored = grown();
    grownAuthored.nodes[0].position = { x: 0, y: 0 };
    const added = withDisplayLayout(grownAuthored, drawn).nodes.find((node) => node.id === "check");

    const rightmost = Math.max(
      ...before.nodes.map((node) => blockRect(node).left + blockRect(node).w),
    );
    expect(added?.position?.x).toBeGreaterThanOrEqual(rightmost);
  });

  it("keeps a later block clear of the ones only the display remembers", () => {
    const drawn = new Map<string, Point>();
    const before = withDisplayLayout(workflow(), drawn);

    // The one authored block sits far to the left of everything remembered, so
    // a band measured from authored positions alone would be drawn over them.
    const next = grown();
    next.nodes[0].position = { x: -1000, y: 0 };
    const added = withDisplayLayout(next, drawn).nodes.find((node) => node.id === "check");

    const remembered = Math.max(
      ...before.nodes
        .filter((node) => node.id !== "start")
        .map((node) => blockRect(node).left + blockRect(node).w),
    );
    expect(added?.position?.x).toBeGreaterThanOrEqual(remembered);
  });
});
