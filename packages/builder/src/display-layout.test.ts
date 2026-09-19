import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { withDisplayLayout } from "./display-layout";

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
