import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import {
  addOutput,
  allOutputs,
  findOutput,
  outputsOf,
  patchOutput,
  removeOutput,
  setOutputTarget,
  unconnectedOutputs,
} from "./outputs.js";

function makeWorkflow(): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "a", type: "agent", name: "Implement", config: {} },
      { id: "b", type: "agent", name: "Review", config: {} },
      { id: "c", type: "agent", name: "Fix", config: {} },
    ],
    edges: [{ id: "out-1", source: "a", target: "b", label: "done", kind: "next" }],
  };
}

describe("outputsOf", () => {
  it("reads a connected output from its edge", () => {
    expect(outputsOf(makeWorkflow(), "a")).toEqual([
      { id: "out-1", label: "done", kind: "next", condition: undefined, target: "b", anchor: undefined },
    ]);
  });

  it("treats an edge with no kind as `next`", () => {
    const workflow = makeWorkflow();
    delete workflow.edges[0].kind;
    expect(outputsOf(workflow, "a")[0].kind).toBe("next");
  });

  it("lists connected outputs before unrouted ones", () => {
    const { workflow } = addOutput(makeWorkflow(), "a", "rework", "send back");
    expect(outputsOf(workflow, "a").map((output) => output.target)).toEqual(["b", null]);
  });

  it("returns nothing for a block with no outputs", () => {
    expect(outputsOf(makeWorkflow(), "c")).toEqual([]);
  });
});

/*
  ANT-194. The templates' loops name the sides they leave and arrive at, and
  those sides were never read: a loop meant to run under the row was drawn
  through the step it returns to.
*/
describe("the sides a connection names", () => {
  const named = (): Workflow => {
    const workflow = makeWorkflow();
    workflow.edges[0] = { ...workflow.edges[0], sourceHandle: "bottom", targetHandle: "bottom" };
    return workflow;
  };

  it("place its port and landing on those sides, apart from each other", () => {
    const [output] = outputsOf(named(), "a");
    expect(output.port).toEqual({ u: 0.65, v: 1 });
    expect(output.anchor).toEqual({ u: 0.35, v: 1 });
  });

  it("give way to a port and landing placed by hand", () => {
    const workflow = named();
    workflow.edges[0] = { ...workflow.edges[0], port: { u: 1, v: 0.2 }, anchor: { u: 0, v: 0.8 } };
    const [output] = outputsOf(workflow, "a");
    expect(output.port).toEqual({ u: 1, v: 0.2 });
    expect(output.anchor).toEqual({ u: 0, v: 0.8 });
  });

  it("are forgotten when the port or landing is put back", () => {
    const reset = patchOutput(named(), "a", "out-1", { port: null, anchor: null });
    const [output] = outputsOf(reset, "a");
    expect(output.port).toBeUndefined();
    expect(output.anchor).toBeUndefined();
  });

  it("forget the arrival side when the connection moves to another step", () => {
    const moved = setOutputTarget(named(), "a", "out-1", "c");
    expect(moved.edges[0].targetHandle).toBeUndefined();
    expect(moved.edges[0].sourceHandle).toBe("bottom");
  });
});

describe("addOutput", () => {
  it("adds an unrouted output and returns its id", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b", "question", "ask");
    const output = findOutput(workflow, "b", outputId);
    expect(output).toMatchObject({ kind: "question", label: "ask", target: null });
  });

  it("does not collide with existing ids", () => {
    const first = addOutput(makeWorkflow(), "b");
    const second = addOutput(first.workflow, "b");
    expect(second.outputId).not.toBe(first.outputId);
    expect(second.outputId).not.toBe("out-1");
  });

  it("creates no edge until the output is routed", () => {
    const { workflow } = addOutput(makeWorkflow(), "b");
    expect(workflow.edges).toHaveLength(1);
  });

  it("leaves the original workflow untouched", () => {
    const original = makeWorkflow();
    addOutput(original, "b");
    expect(original.nodes[1].config.pendingOutputs).toBeUndefined();
  });
});

describe("setOutputTarget", () => {
  it("turns an unrouted output into an edge, keeping its id and fields", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b", "rework", "changes requested");
    const routed = setOutputTarget(workflow, "b", outputId, "c", { u: 0.2, v: 0.8 });

    const edge = routed.edges.find((item) => item.id === outputId);
    expect(edge).toMatchObject({
      source: "b",
      target: "c",
      kind: "rework",
      label: "changes requested",
      anchor: { u: 0.2, v: 0.8 },
    });
    // It must no longer be listed as pending as well as connected.
    expect(outputsOf(routed, "b")).toHaveLength(1);
  });

  it("re-routes an already connected output and updates its anchor", () => {
    const routed = setOutputTarget(makeWorkflow(), "a", "out-1", "c", { u: 1, v: 0.5 });
    expect(routed.edges[0]).toMatchObject({ target: "c", anchor: { u: 1, v: 0.5 } });
  });

  it("clears the anchor when asked, so the arrow slides along the side again", () => {
    const anchored = setOutputTarget(makeWorkflow(), "a", "out-1", "b", { u: 0.1, v: 0.1 });
    const cleared = setOutputTarget(anchored, "a", "out-1", "b", null);
    expect(cleared.edges[0]).not.toHaveProperty("anchor");
  });

  it("disconnecting keeps the output but drops the edge and the anchor", () => {
    const anchored = setOutputTarget(makeWorkflow(), "a", "out-1", "b", { u: 0.5, v: 0.5 });
    const detached = setOutputTarget(anchored, "a", "out-1", null);

    expect(detached.edges).toHaveLength(0);
    expect(outputsOf(detached, "a")).toEqual([
      { id: "out-1", label: "done", kind: "next", condition: undefined, target: null },
    ]);
  });

  it("ignores an output that does not exist", () => {
    const workflow = makeWorkflow();
    expect(setOutputTarget(workflow, "a", "nope", "c")).toBe(workflow);
  });
});

describe("patchOutput", () => {
  it("edits a connected output through its edge", () => {
    const patched = patchOutput(makeWorkflow(), "a", "out-1", {
      label: "approved",
      kind: "stop",
      condition: 'reviewer.decision == "approved"',
    });
    expect(patched.edges[0]).toMatchObject({
      label: "approved",
      kind: "stop",
      condition: 'reviewer.decision == "approved"',
    });
  });

  it("edits an unrouted output in place", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b");
    const patched = patchOutput(workflow, "b", outputId, { label: "ask", kind: "question" });
    expect(findOutput(patched, "b", outputId)).toMatchObject({
      label: "ask",
      kind: "question",
    });
  });

  it("clears a condition when it is set to undefined", () => {
    const withCondition = patchOutput(makeWorkflow(), "a", "out-1", { condition: 'x.y == "z"' });
    const cleared = patchOutput(withCondition, "a", "out-1", { condition: undefined });
    expect(cleared.edges[0]).not.toHaveProperty("condition");
  });
});

describe("removeOutput", () => {
  it("removes a connected output and its edge", () => {
    const removed = removeOutput(makeWorkflow(), "a", "out-1");
    expect(removed.edges).toEqual([]);
    expect(outputsOf(removed, "a")).toEqual([]);
  });

  it("removes an unrouted output", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b");
    const removed = removeOutput(workflow, "b", outputId);
    expect(outputsOf(removed, "b")).toEqual([]);
    expect(removed.nodes[1].config.pendingOutputs).toBeUndefined();
  });
});

describe("unconnectedOutputs", () => {
  it("finds outputs the author added but never routed", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b", "question", "ask");
    expect(unconnectedOutputs(workflow)).toEqual([
      { nodeId: "b", output: expect.objectContaining({ id: outputId, target: null }) },
    ]);
  });

  it("finds nothing when every output leads somewhere", () => {
    expect(unconnectedOutputs(makeWorkflow())).toEqual([]);
  });
});

describe("allOutputs", () => {
  it("keys outputs by the block they leave", () => {
    const map = allOutputs(makeWorkflow());
    expect(Object.keys(map)).toEqual(["a", "b", "c"]);
    expect(map.a).toHaveLength(1);
    expect(map.b).toEqual([]);
  });
});
