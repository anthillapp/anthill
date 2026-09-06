import { describe, expect, it } from "vitest";

import type { Workflow, WorkflowNode } from "./contracts";
import { createEmptyWorkflow } from "./document";
import {
  ValidationCode,
  errorsForEdge,
  errorsForNode,
  validate,
} from "./validate";

function agentNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: "agent-1",
    type: "agent",
    name: "Developer",
    config: {
      role: "developer",
      runtime: "claude-code",
      instructions: "Implement the change.",
    },
    ...overrides,
  };
}

/** Minimal structurally valid workflow: start -> agent -> end. */
function validWorkflow(): Workflow {
  return {
    ...createEmptyWorkflow(),
    nodes: [
      { id: "start-1", type: "start", name: "Start", config: {} },
      agentNode(),
      { id: "end-1", type: "end", name: "End", config: {} },
    ],
    edges: [
      { id: "edge-1", source: "start-1", target: "agent-1" },
      { id: "edge-2", source: "agent-1", target: "end-1" },
    ],
  };
}

function codes(workflow: Workflow): string[] {
  return validate(workflow).errors.map((error) => error.code);
}

describe("validate: baseline", () => {
  it("accepts a minimal valid workflow", () => {
    const result = validate(validWorkflow());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("does not mutate the workflow", () => {
    const workflow = validWorkflow();
    const snapshot = JSON.parse(JSON.stringify(workflow));
    validate(workflow);
    expect(workflow).toEqual(snapshot);
  });
});

describe("validate: start node", () => {
  it("flags a workflow with no start node", () => {
    const workflow = validWorkflow();
    workflow.nodes = workflow.nodes.filter((node) => node.type !== "start");
    workflow.edges = [];
    expect(codes(workflow)).toContain(ValidationCode.MISSING_START_NODE);
  });

  it("flags an empty workflow", () => {
    const result = validate(createEmptyWorkflow());
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual([
      ValidationCode.MISSING_START_NODE,
    ]);
  });

  it("flags more than one start node, once per node", () => {
    const workflow = validWorkflow();
    workflow.nodes.push({
      id: "start-2",
      type: "start",
      name: "Other start",
      config: {},
    });
    const errors = validate(workflow).errors.filter(
      (error) => error.code === ValidationCode.MULTIPLE_START_NODES,
    );
    expect(errors.map((e) => e.nodeId)).toEqual(["start-1", "start-2"]);
  });
});

describe("validate: edges", () => {
  it("flags an edge with an unknown source", () => {
    const workflow = validWorkflow();
    workflow.edges.push({ id: "edge-3", source: "ghost", target: "end-1" });

    const [error] = errorsForEdge(validate(workflow), "edge-3");
    expect(error?.code).toBe(ValidationCode.DANGLING_EDGE);
    expect(error?.message).toMatch(/source "ghost"/);
  });

  it("flags an edge with an unknown target", () => {
    const workflow = validWorkflow();
    workflow.edges.push({ id: "edge-3", source: "start-1", target: "ghost" });
    expect(validate(workflow).errors[0]?.message).toMatch(/target "ghost"/);
  });

  it("reports one error for an edge dangling at both ends", () => {
    const workflow = validWorkflow();
    workflow.edges.push({ id: "edge-3", source: "ghost", target: "phantom" });
    expect(errorsForEdge(validate(workflow), "edge-3")).toHaveLength(1);
  });

  it("accepts self-loops between existing nodes", () => {
    const workflow = validWorkflow();
    workflow.edges.push({ id: "edge-3", source: "agent-1", target: "agent-1" });
    expect(validate(workflow).valid).toBe(true);
  });
});

describe("validate: agent nodes", () => {
  it("flags a missing role", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({
      config: { runtime: "claude-code", instructions: "do it" },
    });
    expect(codes(workflow)).toEqual([ValidationCode.AGENT_MISSING_ROLE]);
  });

  it("flags a missing runtime", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({
      config: { role: "dev", instructions: "do it" },
    });
    expect(codes(workflow)).toEqual([ValidationCode.AGENT_MISSING_RUNTIME]);
  });

  it("flags missing instructions", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({
      config: { role: "dev", runtime: "claude-code" },
    });
    expect(codes(workflow)).toEqual([
      ValidationCode.AGENT_MISSING_INSTRUCTIONS,
    ]);
  });

  it("treats whitespace-only values as empty", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({
      config: { role: "   ", runtime: "\n", instructions: "" },
    });
    expect(codes(workflow)).toEqual([
      ValidationCode.AGENT_MISSING_ROLE,
      ValidationCode.AGENT_MISSING_RUNTIME,
      ValidationCode.AGENT_MISSING_INSTRUCTIONS,
    ]);
  });

  it("treats non-string values as empty", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({
      config: { role: 42, runtime: null, instructions: { a: 1 } },
    });
    expect(codes(workflow)).toHaveLength(3);
  });

  it("attaches errors to the offending node and names it", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = agentNode({ name: "Reviewer", config: {} });
    const errors = errorsForNode(validate(workflow), "agent-1");
    expect(errors).toHaveLength(3);
    expect(errors[0]?.message).toMatch(/"Reviewer"/);
  });

  it("ignores config requirements for non-agent node types", () => {
    const workflow = validWorkflow();
    workflow.nodes[1] = { ...agentNode(), type: "command", config: {} };
    expect(validate(workflow).valid).toBe(true);
  });
});

describe("validate: approval nodes", () => {
  it("flags an approval node with no outgoing edge", () => {
    const workflow = validWorkflow();
    workflow.nodes.push({
      id: "approval-1",
      type: "approval",
      name: "Human gate",
      config: {},
    });
    workflow.edges.push({
      id: "edge-3",
      source: "agent-1",
      target: "approval-1",
    });

    const errors = errorsForNode(validate(workflow), "approval-1");
    expect(errors[0]?.code).toBe(ValidationCode.APPROVAL_NO_OUTGOING_EDGE);
  });

  it("accepts an approval node with a resume path", () => {
    const workflow = validWorkflow();
    workflow.nodes.push({
      id: "approval-1",
      type: "approval",
      name: "Human gate",
      config: {},
    });
    workflow.edges.push(
      { id: "edge-3", source: "agent-1", target: "approval-1" },
      {
        id: "edge-4",
        source: "approval-1",
        target: "end-1",
        label: "approved",
      },
    );
    expect(validate(workflow).valid).toBe(true);
  });
});

describe("validate: duplicate ids", () => {
  it("flags duplicate node ids once", () => {
    const workflow = validWorkflow();
    workflow.nodes.push({ ...agentNode(), name: "Copy" });
    const errors = validate(workflow).errors.filter(
      (error) => error.code === ValidationCode.DUPLICATE_NODE_ID,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.nodeId).toBe("agent-1");
  });

  it("flags duplicate edge ids", () => {
    const workflow = validWorkflow();
    workflow.edges.push({ ...workflow.edges[0]! });
    const errors = validate(workflow).errors.filter(
      (error) => error.code === ValidationCode.DUPLICATE_EDGE_ID,
    );
    expect(errors.map((e) => e.edgeId)).toEqual(["edge-1"]);
  });
});

describe("validate: accumulation", () => {
  it("reports every independent problem in one pass", () => {
    const broken: Workflow = {
      ...createEmptyWorkflow(),
      nodes: [
        { id: "agent-1", type: "agent", name: "Dev", config: {} },
        { id: "approval-1", type: "approval", name: "Gate", config: {} },
      ],
      edges: [{ id: "edge-1", source: "ghost", target: "agent-1" }],
    };

    const result = validate(broken);
    expect(result.valid).toBe(false);
    expect(new Set(result.errors.map((e) => e.code))).toEqual(
      new Set([
        ValidationCode.MISSING_START_NODE,
        ValidationCode.DANGLING_EDGE,
        ValidationCode.AGENT_MISSING_ROLE,
        ValidationCode.AGENT_MISSING_RUNTIME,
        ValidationCode.AGENT_MISSING_INSTRUCTIONS,
        ValidationCode.APPROVAL_NO_OUTGOING_EDGE,
      ]),
    );
  });
});
