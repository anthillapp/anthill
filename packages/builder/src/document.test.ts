import { describe, expect, it } from "vitest";

import type { Workflow, WorkflowNode } from "./contracts";
import {
  WorkflowDocumentError,
  addEdge,
  addNode,
  createEmptyWorkflow,
  createNode,
  defaultConfigForType,
  findEdge,
  findNode,
  incomingEdges,
  moveNode,
  nextEdgeId,
  nextNodeId,
  outgoingEdges,
  removeEdge,
  removeNode,
  renameNode,
  updateEdge,
  updateNodeConfig,
} from "./document";

function node(
  id: string,
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    type: overrides.type ?? "agent",
    name: overrides.name ?? id,
    config: overrides.config ?? {},
    position: overrides.position ?? { x: 0, y: 0 },
  };
}

function sampleWorkflow(): Workflow {
  return {
    id: "wf",
    name: "Sample",
    version: "1.0.0",
    nodes: [
      node("start-1", { type: "start", name: "Start" }),
      node("agent-1", { type: "agent", config: { role: "dev" } }),
      node("end-1", { type: "end", name: "End" }),
    ],
    edges: [
      { id: "edge-1", source: "start-1", target: "agent-1" },
      { id: "edge-2", source: "agent-1", target: "end-1", label: "done" },
    ],
  };
}

describe("lookups", () => {
  it("finds nodes and edges by id", () => {
    const doc = sampleWorkflow();
    expect(findNode(doc, "agent-1")?.name).toBe("agent-1");
    expect(findNode(doc, "nope")).toBeUndefined();
    expect(findEdge(doc, "edge-2")?.label).toBe("done");
    expect(findEdge(doc, "nope")).toBeUndefined();
  });

  it("lists incoming and outgoing edges", () => {
    const doc = sampleWorkflow();
    expect(outgoingEdges(doc, "agent-1").map((e) => e.id)).toEqual(["edge-2"]);
    expect(incomingEdges(doc, "agent-1").map((e) => e.id)).toEqual(["edge-1"]);
    expect(outgoingEdges(doc, "end-1")).toEqual([]);
  });
});

describe("addNode", () => {
  it("appends a node without mutating the input", () => {
    const doc = sampleWorkflow();
    const snapshot = JSON.parse(JSON.stringify(doc));
    const next = addNode(doc, node("agent-2"));

    expect(next).not.toBe(doc);
    expect(next.nodes).toHaveLength(4);
    expect(next.nodes.at(-1)?.id).toBe("agent-2");
    expect(doc).toEqual(snapshot);
  });

  it("keeps untouched nodes identical by reference", () => {
    const doc = sampleWorkflow();
    const next = addNode(doc, node("agent-2"));
    expect(next.nodes[0]).toBe(doc.nodes[0]);
    expect(next.edges).toBe(doc.edges);
  });

  it("rejects duplicate ids", () => {
    const doc = sampleWorkflow();
    expect(() => addNode(doc, node("agent-1"))).toThrow(WorkflowDocumentError);
  });

  it("rejects an empty id", () => {
    const doc = sampleWorkflow();
    expect(() => addNode(doc, node(""))).toThrow(/without an id/);
  });
});

describe("removeNode", () => {
  it("removes the node and every edge touching it", () => {
    const doc = sampleWorkflow();
    const next = removeNode(doc, "agent-1");

    expect(next.nodes.map((n) => n.id)).toEqual(["start-1", "end-1"]);
    expect(next.edges).toEqual([]);
    expect(doc.nodes).toHaveLength(3);
  });

  it("removes self-loop edges too", () => {
    const doc = addEdge(sampleWorkflow(), {
      id: "edge-loop",
      source: "agent-1",
      target: "agent-1",
    });
    expect(removeNode(doc, "agent-1").edges).toEqual([]);
  });

  it("is a no-op for unknown ids", () => {
    const doc = sampleWorkflow();
    expect(removeNode(doc, "nope")).toBe(doc);
  });
});

describe("updateNodeConfig", () => {
  it("shallow-merges into the existing config", () => {
    const doc = sampleWorkflow();
    const next = updateNodeConfig(doc, "agent-1", { runtime: "claude-code" });

    expect(findNode(next, "agent-1")?.config).toEqual({
      role: "dev",
      runtime: "claude-code",
    });
    expect(findNode(doc, "agent-1")?.config).toEqual({ role: "dev" });
  });

  it("overwrites existing keys", () => {
    const next = updateNodeConfig(sampleWorkflow(), "agent-1", {
      role: "reviewer",
    });
    expect(findNode(next, "agent-1")?.config.role).toBe("reviewer");
  });

  it("deletes keys set to undefined", () => {
    const next = updateNodeConfig(sampleWorkflow(), "agent-1", {
      role: undefined,
    });
    expect(findNode(next, "agent-1")?.config).toEqual({});
  });

  it("throws for unknown nodes", () => {
    expect(() => updateNodeConfig(sampleWorkflow(), "nope", {})).toThrow(
      /Unknown node/,
    );
  });
});

describe("moveNode", () => {
  it("sets a new position immutably", () => {
    const doc = sampleWorkflow();
    const next = moveNode(doc, "agent-1", { x: 120, y: 40 });

    expect(findNode(next, "agent-1")?.position).toEqual({ x: 120, y: 40 });
    expect(findNode(doc, "agent-1")?.position).toEqual({ x: 0, y: 0 });
  });

  it("copies the position object rather than aliasing it", () => {
    const position = { x: 1, y: 2 };
    const next = moveNode(sampleWorkflow(), "agent-1", position);
    position.x = 999;
    expect(findNode(next, "agent-1")?.position).toEqual({ x: 1, y: 2 });
  });

  it("throws for unknown nodes", () => {
    expect(() => moveNode(sampleWorkflow(), "nope", { x: 0, y: 0 })).toThrow(
      WorkflowDocumentError,
    );
  });
});

describe("renameNode", () => {
  it("renames without touching config", () => {
    const next = renameNode(sampleWorkflow(), "agent-1", "Developer");
    expect(findNode(next, "agent-1")?.name).toBe("Developer");
    expect(findNode(next, "agent-1")?.config).toEqual({ role: "dev" });
  });
});

describe("addEdge", () => {
  it("appends an edge", () => {
    const doc = sampleWorkflow();
    const next = addEdge(doc, {
      id: "edge-3",
      source: "start-1",
      target: "end-1",
      label: "skip",
    });

    expect(next.edges).toHaveLength(3);
    expect(doc.edges).toHaveLength(2);
    expect(next.nodes).toBe(doc.nodes);
  });

  it("allows parallel edges between the same pair", () => {
    const doc = sampleWorkflow();
    const next = addEdge(doc, {
      id: "edge-3",
      source: "agent-1",
      target: "end-1",
      label: "failed",
    });
    expect(outgoingEdges(next, "agent-1")).toHaveLength(2);
  });

  it("allows self-loops (feedback loops are first-class)", () => {
    const next = addEdge(sampleWorkflow(), {
      id: "edge-3",
      source: "agent-1",
      target: "agent-1",
    });
    expect(findEdge(next, "edge-3")).toBeDefined();
  });

  it("rejects duplicate edge ids", () => {
    expect(() =>
      addEdge(sampleWorkflow(), {
        id: "edge-1",
        source: "start-1",
        target: "end-1",
      }),
    ).toThrow(/already exists/);
  });

  it("rejects dangling endpoints", () => {
    const doc = sampleWorkflow();
    expect(() =>
      addEdge(doc, { id: "x", source: "ghost", target: "end-1" }),
    ).toThrow(/source "ghost"/);
    expect(() =>
      addEdge(doc, { id: "x", source: "start-1", target: "ghost" }),
    ).toThrow(/target "ghost"/);
  });
});

describe("removeEdge", () => {
  it("removes only the named edge and leaves nodes alone", () => {
    const doc = sampleWorkflow();
    const next = removeEdge(doc, "edge-1");
    expect(next.edges.map((e) => e.id)).toEqual(["edge-2"]);
    expect(next.nodes).toBe(doc.nodes);
  });

  it("is a no-op for unknown ids", () => {
    const doc = sampleWorkflow();
    expect(removeEdge(doc, "nope")).toBe(doc);
  });
});

describe("updateEdge", () => {
  it("patches label and condition", () => {
    const next = updateEdge(sampleWorkflow(), "edge-2", {
      label: "approved",
      condition: 'review.status == "approved"',
    });
    expect(findEdge(next, "edge-2")).toMatchObject({
      label: "approved",
      condition: 'review.status == "approved"',
    });
  });

  it("clears fields explicitly set to undefined", () => {
    const next = updateEdge(sampleWorkflow(), "edge-2", { label: undefined });
    expect(findEdge(next, "edge-2")).not.toHaveProperty("label");
  });

  it("leaves untouched fields alone", () => {
    const next = updateEdge(sampleWorkflow(), "edge-2", { condition: "x" });
    expect(findEdge(next, "edge-2")?.label).toBe("done");
  });

  it("reroutes an edge to another node", () => {
    const next = updateEdge(sampleWorkflow(), "edge-2", { target: "start-1" });
    expect(findEdge(next, "edge-2")?.target).toBe("start-1");
  });

  it("rejects rerouting to a node that does not exist", () => {
    expect(() =>
      updateEdge(sampleWorkflow(), "edge-2", { target: "ghost" }),
    ).toThrow(/target "ghost"/);
  });

  it("throws for unknown edges", () => {
    expect(() => updateEdge(sampleWorkflow(), "nope", {})).toThrow(
      /Unknown edge/,
    );
  });

  it("does not mutate the original edge object", () => {
    const doc = sampleWorkflow();
    updateEdge(doc, "edge-2", { label: "changed" });
    expect(doc.edges[1]?.label).toBe("done");
  });
});

describe("factories and id helpers", () => {
  it("creates an empty workflow with overridable fields", () => {
    expect(createEmptyWorkflow()).toMatchObject({ nodes: [], edges: [] });
    expect(createEmptyWorkflow({ name: "Review loop" }).name).toBe(
      "Review loop",
    );
  });

  it("generates the first free node id per type", () => {
    const doc = sampleWorkflow();
    expect(nextNodeId(doc, "agent")).toBe("agent-2");
    expect(nextNodeId(doc, "condition")).toBe("condition-1");
  });

  it("generates the first free edge id", () => {
    expect(nextEdgeId(sampleWorkflow())).toBe("edge-3");
  });

  /**
   * ANT-41. The id is what a running session prints back at Anthill, so a
   * number that comes back on a different block makes a day of journalled
   * events resolve to a step that never did that work.
   */
  describe("an id a block has already had", () => {
    const withBlocks = () => {
      let doc = createEmptyWorkflow();
      doc = addNode(doc, createNode(doc, "agent"));
      doc = addNode(doc, createNode(doc, "agent"));
      return doc;
    };

    it("is not handed to the next block after the first is deleted", () => {
      let doc = withBlocks();
      expect(doc.nodes.map((node) => node.id)).toEqual(["agent-1", "agent-2"]);

      doc = removeNode(doc, "agent-2");
      doc = addNode(doc, createNode(doc, "agent"));
      expect(doc.nodes.map((node) => node.id)).toEqual(["agent-1", "agent-3"]);
    });

    it("is still gone after a save and a reopen", () => {
      let doc = withBlocks();
      doc = removeNode(doc, "agent-2");
      // Whatever a save and a load do to a workflow, they do this.
      doc = JSON.parse(JSON.stringify(doc)) as typeof doc;
      doc = addNode(doc, createNode(doc, "agent"));
      expect(doc.nodes.map((node) => node.id)).toEqual(["agent-1", "agent-3"]);
    });

    it("holds for connections too", () => {
      let doc = withBlocks();
      doc = addEdge(doc, { id: nextEdgeId(doc), source: "agent-1", target: "agent-2" });
      expect(doc.edges[0].id).toBe("edge-1");

      doc = removeEdge(doc, "edge-1");
      doc = addEdge(doc, { id: nextEdgeId(doc), source: "agent-1", target: "agent-2" });
      expect(doc.edges[0].id).toBe("edge-2");
    });

    it("leaves an opened workflow's own ids exactly as they were", () => {
      // Nothing is renumbered on open, whatever shape the ids are in.
      const opened = createEmptyWorkflow({
        nodes: [
          { id: "start", type: "start", name: "Start", config: {} },
          { id: "agent-9", type: "agent", name: "Nine", config: {} },
        ],
      });
      const after = addNode(opened, createNode(opened, "agent"));
      expect(after.nodes.map((node) => node.id)).toEqual(["start", "agent-9", "agent-10"]);
    });
  });

  it("creates nodes with type defaults and a unique id", () => {
    const doc = sampleWorkflow();
    const created = createNode(doc, "agent");
    expect(created.id).toBe("agent-2");
    expect(created.name).toBe("Agent");
    expect(created.config).toEqual(defaultConfigForType("agent"));
    expect(() => addNode(doc, created)).not.toThrow();
  });

  it("honours overrides when creating a node", () => {
    const created = createNode(sampleWorkflow(), "condition", {
      name: "Approved?",
      position: { x: 10, y: 20 },
    });
    expect(created).toMatchObject({
      type: "condition",
      name: "Approved?",
      position: { x: 10, y: 20 },
    });
  });

  it("gives start/end nodes an empty default config", () => {
    expect(defaultConfigForType("start")).toEqual({});
    expect(defaultConfigForType("end")).toEqual({});
  });
});

describe("edit sequences", () => {
  it("supports a build-up then tear-down round trip", () => {
    let doc = createEmptyWorkflow();
    doc = addNode(doc, createNode(doc, "start"));
    doc = addNode(doc, createNode(doc, "agent"));
    doc = addNode(doc, createNode(doc, "end"));
    doc = addEdge(doc, {
      id: nextEdgeId(doc),
      source: "start-1",
      target: "agent-1",
    });
    doc = addEdge(doc, {
      id: nextEdgeId(doc),
      source: "agent-1",
      target: "end-1",
    });

    expect(doc.nodes).toHaveLength(3);
    expect(doc.edges.map((e) => e.id)).toEqual(["edge-1", "edge-2"]);

    doc = removeNode(doc, "agent-1");
    expect(doc.nodes.map((n) => n.id)).toEqual(["start-1", "end-1"]);
    expect(doc.edges).toEqual([]);
  });
});
