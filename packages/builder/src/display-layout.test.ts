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

  it("leaves a block where it was when the graph around it changes", () => {
    const drawn = new Map<string, Point>();
    const before = withDisplayLayout(workflow(), drawn);
    const after = withDisplayLayout(grown(), drawn);

    for (const node of before.nodes) {
      expect(after.nodes.find((item) => item.id === node.id)?.position).toEqual(node.position);
    }
  });

  it("places a block added later clear of the ones already drawn", () => {
    const drawn = new Map<string, Point>();
    const before = withDisplayLayout(workflow(), drawn);
    const added = withDisplayLayout(grown(), drawn).nodes.find((node) => node.id === "check");

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
