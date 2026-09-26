import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@anthill/workflow-schema";

import type { AgentProfile } from "./agents.js";
import {
  WORKFLOWNER_VALIDATION_CODES,
  agentConfig,
  nodesOnCycles,
  slugify,
  validateWorkflow,
} from "./workflow.js";

function node(
  id: string,
  type: WorkflowNode["type"],
  name: string,
  config: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, name, config };
}

/** A complete agent step: action, agent and task all present. */
function step(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return node(id, "agent", name, {
    actionKind: "agent-step",
    agentId: `agent-${id}`,
    task: "Do the work.",
    ...extra,
  });
}

/**
 * A profile for every agent the steps mention, named after its id.
 *
 * Structural tests care that the reference resolves, not what the agent is
 * called; the tests that are about names build the list themselves.
 */
function agentsFor(nodes: WorkflowNode[]): AgentProfile[] {
  const ids = new Set<string>();
  for (const item of nodes) {
    if (item.type !== "agent") continue;
    const { agentId } = agentConfig(item);
    if (agentId) ids.add(agentId);
  }
  return [...ids].map((id) => ({ id, name: id }));
}

function edge(id: string, source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return { id, source, target, ...extra };
}

function makeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  agents: AgentProfile[] = agentsFor(nodes),
): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    metadata: { workflow: { agents } },
    nodes,
    edges,
  };
}

/** Start -> Developer -> End, the smallest valid diagram. */
function minimalWorkflow(): Workflow {
  return makeWorkflow(
    [
      node("s", "start", "Start"),
      step("dev", "Implement", { agentId: "agent-dev" }),
      node("e", "end", "Done"),
    ],
    [edge("e1", "s", "dev"), edge("e2", "dev", "e")],
  );
}

const codesIn = (workflow: Workflow) =>
  validateWorkflow(workflow).errors.map((error) => error.code);

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Code Reviewer")).toBe("code-reviewer");
  });

  it("collapses runs of punctuation and trims edges", () => {
    expect(slugify("  !!Senior   Dev!! ")).toBe("senior-dev");
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("nodesOnCycles", () => {
  it("handles a large directed chain and a cycle without recursive traversal", () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => step(`n${i}`, `Step ${i}`));
    const edges = nodes.slice(1).map((n, i) => edge(`e${i}`, nodes[i].id, n.id));
    const workflow = makeWorkflow(nodes, edges);
    expect(nodesOnCycles(workflow).size).toBe(0);
    workflow.edges.push(edge("back", "n999", "n500"));
    expect(nodesOnCycles(workflow)).toEqual(new Set(nodes.slice(500).map((n) => n.id)));
  });

  it("keeps disconnected cycles and self-loops separate from one-way paths", () => {
    const workflow = makeWorkflow(
      ["a", "b", "c", "d", "e"].map((id) => step(id, id)),
      [edge("ab", "a", "b"), edge("ba", "b", "a"), edge("bc", "b", "c"),
        edge("cc", "c", "c"), edge("de", "d", "e")],
    );
    expect(nodesOnCycles(workflow)).toEqual(new Set(["a", "b", "c"]));
  });
  it("finds nodes on a feedback loop", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("dev", "Implement", { agentId: "agent-dev" }),
        step("rev", "Review", { agentId: "agent-rev" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "dev"),
        edge("e2", "dev", "rev"),
        edge("e3", "rev", "dev", { condition: 'reviewer.decision == "changes_requested"' }),
        edge("e4", "rev", "e"),
      ],
    );
    const cycle = nodesOnCycles(workflow);
    expect(cycle.has("dev")).toBe(true);
    expect(cycle.has("rev")).toBe(true);
    expect(cycle.has("s")).toBe(false);
    expect(cycle.has("e")).toBe(false);
  });

  it("reports nothing for a linear diagram", () => {
    expect(nodesOnCycles(minimalWorkflow()).size).toBe(0);
  });
});

describe("validateWorkflow", () => {
  it("rejects duplicate block, edge and agent profile identities", () => {
    const workflow = minimalWorkflow();
    workflow.nodes.push({ ...workflow.nodes[1], name: "Another task with the same ID" });
    workflow.edges.push({ ...workflow.edges[0] });
    workflow.metadata = { workflow: { agents: [
      { id: "agent-dev", name: "Developer" }, { id: "agent-dev", name: "Different role" },
    ] } };
    expect(codesIn(workflow)).toEqual(expect.arrayContaining([
      WORKFLOWNER_VALIDATION_CODES.DUPLICATE_BLOCK_ID,
      WORKFLOWNER_VALIDATION_CODES.DUPLICATE_EDGE_ID,
      WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_ID,
    ]));
  });
  it("accepts a minimal diagram", () => {
    const result = validateWorkflow(minimalWorkflow());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("requires a target harness", () => {
    const workflow = { ...minimalWorkflow(), target: undefined };
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.NO_TARGET);
  });

  it("requires exactly one start block", () => {
    const withoutStart = makeWorkflow(
      [step("dev", "Implement", { agentId: "agent-dev" }), node("e", "end", "Done")],
      [edge("e1", "dev", "e")],
    );
    expect(codesIn(withoutStart)).toContain(WORKFLOWNER_VALIDATION_CODES.NO_START_BLOCK);

    const two = minimalWorkflow();
    two.nodes.push(node("s2", "start", "Start 2"));
    expect(codesIn(two)).toContain(WORKFLOWNER_VALIDATION_CODES.MULTIPLE_START_BLOCKS);
  });

  it("requires an end block", () => {
    const workflow = makeWorkflow(
      [node("s", "start", "Start"), step("dev", "Implement", { agentId: "agent-dev" })],
      [edge("e1", "s", "dev")],
    );
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.NO_END_BLOCK);
  });

  it("flags unreachable blocks", () => {
    const workflow = minimalWorkflow();
    workflow.nodes.push(step("orphan", "Orphan"));
    const errors = validateWorkflow(workflow).errors;
    expect(errors.some((e) => e.code === WORKFLOWNER_VALIDATION_CODES.UNREACHABLE_BLOCK && e.nodeId === "orphan")).toBe(true);
  });

  it("flags dangling connections", () => {
    const workflow = minimalWorkflow();
    workflow.edges.push(edge("bad", "dev", "ghost"));
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.DANGLING_CONNECTION);
  });

  it("rejects node types the workflow does not support", () => {
    const workflow = minimalWorkflow();
    workflow.nodes.push(node("cmd", "command", "Run tests"));
    workflow.edges.push(edge("e3", "dev", "cmd"));
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.UNSUPPORTED_BLOCK_TYPE);
  });

  it("requires an action, an agent and a task on every step", () => {
    const workflow = makeWorkflow(
      [node("s", "start", "Start"), node("a", "agent", "Untitled", {}), node("e", "end", "Done")],
      [edge("e1", "s", "a"), edge("e2", "a", "e")],
    );
    const codes = codesIn(workflow);
    expect(codes).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION);
    expect(codes).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_AGENT);
    expect(codes).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK);
  });

  it("lets several steps share one agent – that is a one-agent workflow", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        step("b", "Fix review findings", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "e")],
    );
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it("rejects two different agents that share one name", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Review", { agentId: "agent-1" }),
        step("b", "Review again", { agentId: "agent-2" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "e")],
      [
        { id: "agent-1", name: "Reviewer" },
        { id: "agent-2", name: "reviewer" },
      ],
    );
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_NAME);
  });

  it("reports a duplicate name once, not once per step using it", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Review", { agentId: "agent-1" }),
        step("b", "Review again", { agentId: "agent-2" }),
        step("c", "Review once more", { agentId: "agent-2" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "c"), edge("e4", "c", "e")],
      [
        { id: "agent-1", name: "Reviewer" },
        { id: "agent-2", name: "Reviewer" },
      ],
    );
    const duplicates = codesIn(workflow).filter(
      (code) => code === WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_NAME,
    );
    expect(duplicates).toHaveLength(1);
  });

  it("reports a step pointing at an agent the workflow does not have", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-gone" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "e")],
      [{ id: "agent-dev", name: "Developer" }],
    );
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT);
  });

  it("wants an agent to have a usable name, since it becomes a file name", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "e")],
      [{ id: "agent-dev", name: "" }],
    );
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.AGENT_MISSING_NAME);
  });

  it("points a nameless agent at a step using it, so the problem is actionable", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "e")],
      [{ id: "agent-dev", name: "" }],
    );
    const problem = validateWorkflow(workflow).errors.find(
      (error) => error.code === WORKFLOWNER_VALIDATION_CODES.AGENT_MISSING_NAME,
    );
    expect(problem?.nodeId).toBe("a");
  });

  it("says nothing about an agent in the library that no step uses yet", () => {
    // Half-filled library entries are how the author gets to a named agent;
    // reporting them is an error they cannot act on without giving up.
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "e")],
      [
        { id: "agent-dev", name: "Developer" },
        { id: "agent-new", name: "" },
      ],
    );
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it("keeps every step valid when an agent is renamed", () => {
    // The name lives on the profile and nowhere else, so there is nothing on a
    // step for a rename to leave stale.
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        step("b", "Fix", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "e")],
      [{ id: "agent-dev", name: "Developer" }],
    );
    const renamed = makeWorkflow(workflow.nodes, workflow.edges, [
      { id: "agent-dev", name: "Engineer" },
    ]);
    expect(validateWorkflow(renamed).errors).toEqual([]);
  });

  it("requires an approval gate to have somewhere to go", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        node("gate", "approval", "Ship it?", { prompt: "Ship?" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "gate")],
    );
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.APPROVAL_NO_PATH);
  });

  it("accepts an approval gate that has a path onward", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        node("gate", "approval", "Ship it?", { prompt: "Ship?" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "gate"), edge("e2", "gate", "e")],
    );
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it("rejects an unparseable edge condition", () => {
    const workflow = minimalWorkflow();
    workflow.edges[1].condition = "developer.status ~= broken";
    expect(codesIn(workflow)).toContain(WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION);
  });

  it("still catches a dangling agent reference and an unbounded loop when the steps use one of the newer catalog actions", () => {
    // Regression guard for the block-library catalog expansion: validation
    // reads `config.actionKind` generically (see `agentConfig`/`isActionKind`),
    // so nothing about adding 18 new action kinds should have special-cased
    // the original eleven. This workflow uses two actions that did not exist
    // before that expansion and still trips both checks.
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("draft", "Draft the artifact", {
          actionKind: "generate-artifact",
          agentId: "agent-ghost", // not in the profile list below
        }),
        step("review", "Security review", { actionKind: "security-privacy-review" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "draft"),
        edge("e2", "draft", "review"),
        edge("e3", "review", "draft", { condition: 'reviewer.decision == "changes_requested"' }),
        edge("e4", "review", "e"),
      ],
      [{ id: "agent-review", name: "Reviewer" }],
    );

    const codes = codesIn(workflow);
    expect(codes).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT);
    expect(codes).toContain(WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP);

    // Bounding the loop clears that one code without touching the dangling
    // reference, proving the two checks are independent of each other and of
    // which action kind sits on the loop.
    workflow.nodes.find((n) => n.id === "draft")!.config.maxIterations = 3;
    workflow.nodes.find((n) => n.id === "review")!.config.maxIterations = 3;
    const afterBounding = codesIn(workflow);
    expect(afterBounding).not.toContain(WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP);
    expect(afterBounding).toContain(WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT);
  });

  it("requires a pass limit on blocks that sit on a loop", () => {
    const looping = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("dev", "Implement", { agentId: "agent-dev" }),
        step("rev", "Review", { agentId: "agent-rev" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "dev"),
        edge("e2", "dev", "rev"),
        edge("e3", "rev", "dev", { condition: 'reviewer.decision == "changes_requested"' }),
        edge("e4", "rev", "e"),
      ],
    );
    expect(codesIn(looping)).toContain(WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP);

    looping.nodes[1].config.maxIterations = 3;
    looping.nodes[2].config.maxIterations = 3;
    expect(codesIn(looping)).not.toContain(WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP);
  });

  it("flags a block that leads nowhere", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        step("b", "Orphan tail", { agentId: "agent-x" }),
        node("e", "end", "Done"),
      ],
      [edge("e1", "s", "a"), edge("e2", "a", "e"), edge("e3", "a", "b")],
    );
    const errors = validateWorkflow(workflow).errors;
    expect(
      errors.some(
        (error) =>
          error.code === WORKFLOWNER_VALIDATION_CODES.DEAD_END_BLOCK && error.nodeId === "b",
      ),
    ).toBe(true);
  });

  it("requires one unconditional path out of a branch", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("rev", "Review", { agentId: "agent-rev" }),
        step("fix", "Fix", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "rev"),
        edge("e2", "rev", "fix", { condition: 'reviewer.decision == "changes_requested"' }),
        edge("e3", "rev", "e", { condition: 'reviewer.decision == "approved"' }),
        edge("e4", "fix", "e"),
      ],
    );
    // Both paths conditional: nothing says what to do when neither matches.
    expect(codesIn(workflow)).toContain(
      WORKFLOWNER_VALIDATION_CODES.BRANCH_WITHOUT_FALLBACK,
    );

    workflow.edges[2].condition = undefined;
    expect(codesIn(workflow)).not.toContain(
      WORKFLOWNER_VALIDATION_CODES.BRANCH_WITHOUT_FALLBACK,
    );
  });

  it("rejects a condition that reads from an agent the workflow does not have", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        step("a", "Implement", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "a"),
        edge("e2", "a", "e", { condition: 'qa.status == "passed"' }),
      ],
    );
    expect(codesIn(workflow)).toContain(
      WORKFLOWNER_VALIDATION_CODES.CONDITION_UNKNOWN_AGENT,
    );
  });

  it("wants the paths out of an approval gate labelled", () => {
    const workflow = makeWorkflow(
      [
        node("s", "start", "Start"),
        node("gate", "approval", "Ship it?", { prompt: "Ship?" }),
        step("fix", "Fix", { agentId: "agent-dev" }),
        node("e", "end", "Done"),
      ],
      [
        edge("e1", "s", "gate"),
        edge("e2", "gate", "e"),
        edge("e3", "gate", "fix"),
        edge("e4", "fix", "e"),
      ],
    );
    expect(codesIn(workflow)).toContain(
      WORKFLOWNER_VALIDATION_CODES.APPROVAL_UNLABELLED_PATHS,
    );

    workflow.edges[1].label = "approved";
    workflow.edges[2].label = "rejected";
    expect(codesIn(workflow)).not.toContain(
      WORKFLOWNER_VALIDATION_CODES.APPROVAL_UNLABELLED_PATHS,
    );
  });

  it("flags an output that was added but never routed", () => {
    const workflow = minimalWorkflow();
    workflow.nodes[1].config.pendingOutputs = [
      { id: "out-9", kind: "rework", label: "send back" },
    ];
    const errors = validateWorkflow(workflow).errors;
    const unconnected = errors.find(
      (error) => error.code === WORKFLOWNER_VALIDATION_CODES.OUTPUT_NOT_CONNECTED,
    );
    expect(unconnected?.nodeId).toBe("dev");
    // The message should name the output the way the author sees it.
    expect(unconnected?.message).toContain("send back");
  });

  it("names an unlabelled output by its kind", () => {
    const workflow = minimalWorkflow();
    workflow.nodes[1].config.pendingOutputs = [{ id: "out-9", kind: "question" }];
    const message = validateWorkflow(workflow).errors.find(
      (error) => error.code === WORKFLOWNER_VALIDATION_CODES.OUTPUT_NOT_CONNECTED,
    )?.message;
    expect(message).toContain("question");
  });

  it("collects every problem rather than stopping at the first", () => {
    const workflow = makeWorkflow([node("a", "agent", "Untitled", {})], []);
    expect(validateWorkflow(workflow).errors.length).toBeGreaterThan(2);
  });
});
