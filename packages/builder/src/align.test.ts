import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { addOutput, findOutput } from "@anthill/workflow";

import { centerOutputs } from "./align";
import { PORT_SPACING } from "./geometry";
import { STEP_SIZE } from "./workflow-canvas-model";

function makeWorkflow(): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    nodes: [
      {
        id: "a",
        type: "agent",
        name: "Implement",
        config: { actionKind: "agent-step", agentId: "r1", task: "x" },
        position: { x: 0, y: 0 },
      },
      {
        id: "b",
        type: "agent",
        name: "Review",
        config: { actionKind: "llm-review", agentId: "r2", task: "y" },
        position: { x: 400, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "a", target: "b" }],
  };
}

describe("centerOutputs — ports", () => {
  it("puts a port that drifted off the middle of a side back on it", () => {
    const workflow = makeWorkflow();
    // Near the top-left corner of the bottom edge.
    workflow.edges[0].port = { u: 0.1, v: 0.97 };

    const centred = centerOutputs(workflow, { kind: "all" });
    expect(findOutput(centred, "a", "e1")?.port).toEqual({ u: 0.5, v: 1 });
  });

  it("keeps the side the author chose", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].port = { u: 0.03, v: 0.8 };

    expect(findOutput(centerOutputs(workflow, { kind: "all" }), "a", "e1")?.port).toEqual({
      u: 0,
      v: 0.5,
    });
  });

  it("hands a port on the right edge back to the automatic spread", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].port = { u: 0.98, v: 0.9 };

    // Automatic placement is already centred on the right edge, and staying
    // automatic means later outputs keep sharing the edge evenly.
    expect(findOutput(centerOutputs(workflow, { kind: "all" }), "a", "e1")?.port)
      .toBeUndefined();
  });

  it("spreads several ports on one side instead of stacking them", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "a", "rework", "back");
    workflow.edges[0].port = { u: 0.2, v: 1 };
    const pending = workflow.nodes[0].config.pendingOutputs as Record<string, unknown>[];
    pending[0].port = { u: 0.8, v: 0.98 };

    const centred = centerOutputs(workflow, { kind: "all" });
    const first = findOutput(centred, "a", "e1")?.port;
    const second = findOutput(centred, "a", outputId)?.port;

    expect(first?.v).toBe(1);
    expect(second?.v).toBe(1);
    expect(second!.u - first!.u).toBeCloseTo(PORT_SPACING / STEP_SIZE.w, 6);
  });

  it("leaves a port alone when the author never placed it", () => {
    const centred = centerOutputs(makeWorkflow(), { kind: "all" });
    expect(centred).toEqual(makeWorkflow());
  });
});

describe("centerOutputs — arrowheads", () => {
  it("puts a landing back on the middle of the side it arrives at", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].anchor = { u: 0.02, v: 0.95 };

    const centred = centerOutputs(workflow, { kind: "all" });
    expect(centred.edges[0].anchor).toEqual({ u: 0, v: 0.5 });
  });

  it("spreads two arrows arriving at the same side", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].anchor = { u: 0, v: 0.4 };
    workflow.edges.push({
      id: "e2",
      source: "a",
      target: "b",
      anchor: { u: 0.01, v: 0.6 },
    });

    const centred = centerOutputs(workflow, { kind: "all" });
    const [first, second] = centred.edges.map((edge) => edge.anchor!);
    expect(second.v - first.v).toBeCloseTo(PORT_SPACING / STEP_SIZE.h, 6);
  });

  it("leaves an arrow that was never anchored to keep sliding along the side", () => {
    expect(centerOutputs(makeWorkflow(), { kind: "all" }).edges[0].anchor).toBeUndefined();
  });
});

describe("centerOutputs — scope", () => {
  it("touches only the block asked for", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].port = { u: 0.1, v: 0.97 };
    workflow.edges[0].anchor = { u: 0.02, v: 0.95 };

    const centred = centerOutputs(workflow, { kind: "block", nodeId: "a" });
    expect(findOutput(centred, "a", "e1")?.port).toEqual({ u: 0.5, v: 1 });
    // The landing is on b, which was not in scope.
    expect(centred.edges[0].anchor).toEqual({ u: 0.02, v: 0.95 });
  });

  it("tidies both ends of one arrow", () => {
    const workflow = makeWorkflow();
    workflow.edges[0].port = { u: 0.1, v: 0.97 };
    workflow.edges[0].anchor = { u: 0.02, v: 0.95 };

    const centred = centerOutputs(workflow, {
      kind: "output",
      nodeId: "a",
      outputId: "e1",
    });
    expect(findOutput(centred, "a", "e1")?.port).toEqual({ u: 0.5, v: 1 });
    expect(centred.edges[0].anchor).toEqual({ u: 0, v: 0.5 });
  });

  it("does nothing to a workflow that is already tidy", () => {
    const workflow = makeWorkflow();
    expect(centerOutputs(workflow, { kind: "all" })).toBe(workflow);
  });
});
