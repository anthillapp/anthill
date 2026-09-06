/**
 * Rules for drawing connections.
 *
 * These live apart from `document.test.ts` because they cover the gesture the
 * canvas performs rather than the document operations themselves — and because
 * handle-dragging cannot be simulated in jsdom, this is the only place the
 * behaviour is actually pinned down.
 */

import { describe, expect, it } from "vitest";

import type { Workflow } from "./contracts";
import { canConnect, updateEdge } from "./document";

function graph(): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    nodes: [
      { id: "start-1", type: "start", name: "Start", config: {} },
      { id: "dev", type: "agent", name: "Developer", config: {} },
      { id: "rev", type: "agent", name: "Reviewer", config: {} },
      { id: "end-1", type: "end", name: "Done", config: {} },
    ],
    edges: [{ id: "edge-1", source: "dev", target: "rev" }],
  };
}

describe("canConnect", () => {
  it("allows a plain connection between two agents", () => {
    expect(canConnect(graph(), { source: "rev", target: "dev" })).toBe(true);
  });

  it("refuses a block connecting to itself", () => {
    expect(canConnect(graph(), { source: "dev", target: "dev" })).toBe(false);
  });

  it("refuses an incomplete drag", () => {
    expect(canConnect(graph(), { source: "dev", target: null })).toBe(false);
    expect(canConnect(graph(), { source: null, target: "dev" })).toBe(false);
  });

  it("refuses endpoints that are not blocks in this diagram", () => {
    expect(canConnect(graph(), { source: "dev", target: "ghost" })).toBe(false);
  });

  it("refuses anything flowing into the start block", () => {
    expect(canConnect(graph(), { source: "dev", target: "start-1" })).toBe(false);
  });

  it("refuses anything leaving the end block", () => {
    expect(canConnect(graph(), { source: "end-1", target: "dev" })).toBe(false);
  });

  it("allows several connections into the same block from different blocks", () => {
    const doc = graph();
    expect(canConnect(doc, { source: "start-1", target: "rev" })).toBe(true);
  });

  it("allows a second connection between the same pair on different sides", () => {
    const doc = graph();
    expect(
      canConnect(doc, {
        source: "dev",
        target: "rev",
        sourceHandle: "bottom",
        targetHandle: "bottom",
      }),
    ).toBe(true);
  });

  it("refuses a duplicate that would stack invisibly on an existing edge", () => {
    const doc = graph();
    // edge-1 has no handles recorded, so an unanchored repeat is the same edge.
    expect(canConnect(doc, { source: "dev", target: "rev" })).toBe(false);
  });

  it("treats a null handle and a missing handle as the same side", () => {
    const doc = graph();
    expect(
      canConnect(doc, {
        source: "dev",
        target: "rev",
        sourceHandle: null,
        targetHandle: null,
      }),
    ).toBe(false);
  });

  it("does not let an edge being re-routed block itself", () => {
    const doc = graph();
    expect(
      canConnect(doc, { source: "dev", target: "rev", edgeId: "edge-1" }),
    ).toBe(true);
  });
});

describe("updateEdge — connection anchors", () => {
  it("records which side each end attaches to", () => {
    const next = updateEdge(graph(), "edge-1", {
      sourceHandle: "bottom",
      targetHandle: "top",
    });
    expect(next.edges[0]).toMatchObject({
      sourceHandle: "bottom",
      targetHandle: "top",
    });
  });

  it("clears an anchor when it is set back to undefined", () => {
    let doc = updateEdge(graph(), "edge-1", { sourceHandle: "bottom" });
    doc = updateEdge(doc, "edge-1", { sourceHandle: undefined });
    expect(doc.edges[0]).not.toHaveProperty("sourceHandle");
  });

  it("re-routes both endpoints at once", () => {
    const next = updateEdge(graph(), "edge-1", {
      source: "start-1",
      target: "end-1",
      sourceHandle: "right",
      targetHandle: "left",
    });
    expect(next.edges[0]).toMatchObject({
      source: "start-1",
      target: "end-1",
      sourceHandle: "right",
      targetHandle: "left",
    });
  });

  it("leaves the original workflow untouched", () => {
    const doc = graph();
    updateEdge(doc, "edge-1", { sourceHandle: "top" });
    expect(doc.edges[0]).not.toHaveProperty("sourceHandle");
  });
});
