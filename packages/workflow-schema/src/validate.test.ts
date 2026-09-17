import { describe, expect, it } from "vitest";

import type {
  EdgeCondition,
  NodeType,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./types.js";
import {
  VALIDATION_CODES,
  evaluateEdgeCondition,
  parseEdgeCondition,
  validateWorkflow,
} from "./validate.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function node(
  id: string,
  type: NodeType,
  config: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, name: id, config };
}

function edge(
  id: string,
  source: string,
  target: string,
  condition?: EdgeCondition,
): WorkflowEdge {
  return condition === undefined
    ? { id, source, target }
    : { id, source, target, condition };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "wf", version: "1.0.0", nodes, edges };
}

function agentConfig(overrides: Record<string, unknown> = {}) {
  return {
    role: "implementer",
    runtime: "codex-cli",
    instructions: "Do the work",
    ...overrides,
  };
}

function codes(result: { errors: { code: string }[] }): string[] {
  return result.errors.map((e) => e.code);
}

/** start -> agent -> end, everything valid. */
function happyWorkflow(): Workflow {
  return workflow(
    [
      node("start", "start"),
      node("impl", "agent", agentConfig()),
      node("end", "end"),
    ],
    [edge("e1", "start", "impl"), edge("e2", "impl", "end")],
  );
}

/* -------------------------------------------------------------------------- */
/* parseEdgeCondition                                                         */
/* -------------------------------------------------------------------------- */

describe("parseEdgeCondition", () => {
  it("parses a dotted path compared to a double-quoted string", () => {
    const result = parseEdgeCondition('review.status == "approved"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.condition).toMatchObject({
      rawPath: "review.status",
      path: ["review", "status"],
      operator: "==",
      value: "approved",
      valueType: "string",
    });
  });

  it("parses single-quoted strings, numbers and booleans", () => {
    const single = parseEdgeCondition("review.status != 'rejected'");
    expect(single.ok && single.condition.value).toBe("rejected");
    expect(single.ok && single.condition.operator).toBe("!=");

    const number = parseEdgeCondition("tests.failed == 0");
    expect(number.ok && number.condition.value).toBe(0);
    expect(number.ok && number.condition.valueType).toBe("number");

    const negative = parseEdgeCondition("delta.score != -12.5");
    expect(negative.ok && negative.condition.value).toBe(-12.5);

    const bool = parseEdgeCondition("gate.approved == true");
    expect(bool.ok && bool.condition.value).toBe(true);
    expect(bool.ok && bool.condition.valueType).toBe("boolean");

    const falsy = parseEdgeCondition("gate.approved != false");
    expect(falsy.ok && falsy.condition.value).toBe(false);
  });

  it("accepts a single-segment path and tolerates loose whitespace", () => {
    const single = parseEdgeCondition("approved==true");
    expect(single.ok && single.condition.path).toEqual(["approved"]);

    const spaced = parseEdgeCondition('   a.b.c   ==   "x"   ');
    expect(spaced.ok && spaced.condition.path).toEqual(["a", "b", "c"]);
  });

  it("unescapes escaped quotes inside string literals", () => {
    const result = parseEdgeCondition('review.title == "say \\"hi\\""');
    expect(result.ok && result.condition.value).toBe('say "hi"');
  });

  it.each([
    ["", "empty condition"],
    ["   ", "whitespace only"],
    ["review.status", "no operator"],
    ["review.status = 'approved'", "assignment instead of comparison"],
    ["review.status === 'approved'", "strict-equality operator"],
    ["review.score > 5", "unsupported operator"],
    ["review.score >= 5", "unsupported operator"],
    ['review.status == approved', "bare identifier on the right"],
    ['review.status == "a" && x.y == "b"', "boolean composition"],
    ['!review.approved', "negation"],
    ['review.status == "unterminated', "unterminated string"],
    ['review["status"] == "approved"', "bracket access"],
    ['review.status() == "approved"', "function call"],
    ["1 == 1", "literal on the left"],
    ["review..status == 'x'", "empty path segment"],
    ["review.status == null", "null literal"],
    ["review.status == undefined", "undefined literal"],
    ["review.status == 0x10", "non-decimal number"],
  ])("rejects %j (%s)", (input) => {
    const result = parseEdgeCondition(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects non-string input defensively", () => {
    const result = parseEdgeCondition(42 as unknown as string);
    expect(result.ok).toBe(false);
  });
});

describe("evaluateEdgeCondition", () => {
  const context = {
    review: { status: "approved", score: 9 },
    gate: { approved: true },
  };

  it("evaluates == and != against a dotted path", () => {
    expect(evaluateEdgeCondition('review.status == "approved"', context)).toBe(true);
    expect(evaluateEdgeCondition('review.status != "approved"', context)).toBe(false);
    expect(evaluateEdgeCondition("review.score == 9", context)).toBe(true);
    expect(evaluateEdgeCondition("gate.approved == true", context)).toBe(true);
  });

  it("treats a missing path as undefined rather than throwing", () => {
    expect(evaluateEdgeCondition('missing.deep.path == "x"', context)).toBe(false);
    expect(evaluateEdgeCondition('missing.deep.path != "x"', context)).toBe(true);
  });

  it("throws on an unsupported condition", () => {
    expect(() => evaluateEdgeCondition("review.score > 5", context)).toThrow(
      /Invalid edge condition/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* validateWorkflow                                                           */
/* -------------------------------------------------------------------------- */

describe("validateWorkflow", () => {
  it("accepts a valid workflow", () => {
    const result = validateWorkflow(happyWorkflow());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("flags a node id with whitespace as INVALID_NODE_ID (not reportable)", () => {
    const result = validateWorkflow(
      workflow(
        [node("start", "start"), node("code review", "agent", agentConfig())],
        [edge("e1", "start", "code review")],
      ),
    );
    expect(codes(result)).toContain("INVALID_NODE_ID");
  });

  it("accepts node ids from the full reportable character class", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("start:1", "start"),
          node("code.review:1", "agent", agentConfig()),
          node("end.done", "end"),
        ],
        [
          edge("e1", "start:1", "code.review:1"),
          edge("e2", "code.review:1", "end.done"),
        ],
      ),
    );
    expect(codes(result)).not.toContain("INVALID_NODE_ID");
  });

  describe("exactly one start node", () => {
    it("fails when there is no start node", () => {
      const result = validateWorkflow(
        workflow([node("a", "agent", agentConfig()), node("end", "end")], [
          edge("e1", "a", "end"),
        ]),
      );
      expect(codes(result)).toContain(VALIDATION_CODES.NO_START_NODE);
      expect(result.valid).toBe(false);
    });

    it("fails when there are two start nodes", () => {
      const result = validateWorkflow(
        workflow(
          [node("s1", "start"), node("s2", "start"), node("end", "end")],
          [edge("e1", "s1", "end"), edge("e2", "s2", "end")],
        ),
      );
      expect(codes(result)).toContain(VALIDATION_CODES.MULTIPLE_START_NODES);
    });

    it("passes with exactly one start node", () => {
      expect(validateWorkflow(happyWorkflow()).valid).toBe(true);
    });
  });

  describe("reachability", () => {
    it("flags a node that cannot be reached from start", () => {
      const wf = happyWorkflow();
      wf.nodes.push(node("orphan", "agent", agentConfig()));
      const result = validateWorkflow(wf);
      const unreachable = result.errors.filter(
        (e) => e.code === VALIDATION_CODES.UNREACHABLE_NODE,
      );
      expect(unreachable).toHaveLength(1);
      expect(unreachable[0]?.nodeId).toBe("orphan");
    });

    it("flags a node only reachable by walking edges backwards", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("end", "end"), node("pre", "command")],
          [edge("e1", "start", "end"), edge("e2", "pre", "start")],
        ),
      );
      expect(
        result.errors.some(
          (e) =>
            e.code === VALIDATION_CODES.UNREACHABLE_NODE && e.nodeId === "pre",
        ),
      ).toBe(true);
    });

    it("treats a deep chain as reachable", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("a", "command"),
            node("b", "condition"),
            node("c", "command"),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "a"),
            edge("e2", "a", "b"),
            edge("e3", "b", "c"),
            edge("e4", "c", "end"),
          ],
        ),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("dangling edges", () => {
    it("flags an unknown source and an unknown target", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("end", "end")],
          [
            edge("e1", "start", "end"),
            edge("e2", "ghost", "end"),
            edge("e3", "start", "phantom"),
          ],
        ),
      );
      const found = result.errors.filter((e) =>
        [
          VALIDATION_CODES.DANGLING_EDGE_SOURCE,
          VALIDATION_CODES.DANGLING_EDGE_TARGET,
        ].includes(e.code as never),
      );
      expect(found.map((e) => e.edgeId).sort()).toEqual(["e2", "e3"]);
    });

    it("passes when every edge endpoint exists", () => {
      expect(validateWorkflow(happyWorkflow()).valid).toBe(true);
    });
  });

  describe("agent node config", () => {
    it("flags missing role, runtime and instructions", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("a", "agent", {}), node("end", "end")],
          [edge("e1", "start", "a"), edge("e2", "a", "end")],
        ),
      );
      expect(codes(result)).toEqual(
        expect.arrayContaining([
          VALIDATION_CODES.AGENT_MISSING_ROLE,
          VALIDATION_CODES.AGENT_MISSING_RUNTIME,
          VALIDATION_CODES.AGENT_MISSING_INSTRUCTIONS,
        ]),
      );
      expect(
        result.errors.every((e) => e.nodeId === "a" || e.nodeId === undefined),
      ).toBe(true);
    });

    it("treats whitespace-only values as empty", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("a", "agent", agentConfig({ role: "   ", instructions: "" })),
            node("end", "end"),
          ],
          [edge("e1", "start", "a"), edge("e2", "a", "end")],
        ),
      );
      expect(codes(result)).toEqual(
        expect.arrayContaining([
          VALIDATION_CODES.AGENT_MISSING_ROLE,
          VALIDATION_CODES.AGENT_MISSING_INSTRUCTIONS,
        ]),
      );
      expect(codes(result)).not.toContain(VALIDATION_CODES.AGENT_MISSING_RUNTIME);
    });

    it("does not apply agent rules to non-agent nodes", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("cmd", "command", {}), node("end", "end")],
          [edge("e1", "start", "cmd"), edge("e2", "cmd", "end")],
        ),
      );
      expect(result.valid).toBe(true);
    });

    it("passes with a complete agent config", () => {
      expect(validateWorkflow(happyWorkflow()).valid).toBe(true);
    });
  });

  describe("availableRuntimes", () => {
    it("flags a runtime that is not installed", () => {
      const result = validateWorkflow(happyWorkflow(), {
        availableRuntimes: ["claude-code"],
      });
      const err = result.errors.find(
        (e) => e.code === VALIDATION_CODES.UNKNOWN_RUNTIME,
      );
      expect(err?.nodeId).toBe("impl");
      expect(err?.message).toContain("codex-cli");
    });

    it("passes when the runtime is available", () => {
      const result = validateWorkflow(happyWorkflow(), {
        availableRuntimes: ["codex-cli", "claude-code"],
      });
      expect(result.valid).toBe(true);
    });

    it("skips the check when no runtime list is supplied", () => {
      expect(validateWorkflow(happyWorkflow(), {}).valid).toBe(true);
    });
  });

  describe("edge conditions", () => {
    it("flags an unsupported condition expression", () => {
      const wf = happyWorkflow();
      wf.edges[1] = edge("e2", "impl", "end", "impl.score > 5");
      const result = validateWorkflow(wf);
      const err = result.errors.find(
        (e) => e.code === VALIDATION_CODES.INVALID_EDGE_CONDITION,
      );
      expect(err?.edgeId).toBe("e2");
      expect(err?.message).toContain("unsupported condition");
    });

    it("accepts a supported condition expression", () => {
      const wf = happyWorkflow();
      wf.edges[1] = edge("e2", "impl", "end", 'impl.status == "success"');
      expect(validateWorkflow(wf).valid).toBe(true);
    });
  });

  describe("approval nodes", () => {
    it("flags an approval node with no outgoing edge", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("gate", "approval"), node("end", "end")],
          [edge("e1", "start", "gate"), edge("e2", "start", "end")],
        ),
      );
      const err = result.errors.find(
        (e) => e.code === VALIDATION_CODES.APPROVAL_NODE_NO_OUTGOING_EDGE,
      );
      expect(err?.nodeId).toBe("gate");
    });

    it("passes when the approval node has a resume path", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("gate", "approval"), node("end", "end")],
          [edge("e1", "start", "gate"), edge("e2", "gate", "end")],
        ),
      );
      expect(result.valid).toBe(true);
    });

    it("does not count a dangling edge as a resume path", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("gate", "approval")],
          [edge("e1", "start", "gate"), edge("e2", "gate", "nowhere")],
        ),
      );
      expect(codes(result)).toContain(
        VALIDATION_CODES.APPROVAL_NODE_NO_OUTGOING_EDGE,
      );
    });
  });

  describe("loop bounds", () => {
    it("flags a cycle where no node sets a retry limit", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("impl", "agent", agentConfig()),
            node("review", "agent", agentConfig({ role: "reviewer" })),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "impl"),
            edge("e2", "impl", "review"),
            edge("e3", "review", "impl", 'review.status != "approved"'),
            edge("e4", "review", "end", 'review.status == "approved"'),
          ],
        ),
      );
      const err = result.errors.find(
        (e) => e.code === VALIDATION_CODES.UNBOUNDED_LOOP,
      );
      expect(err).toBeDefined();
      expect(err?.message).toContain("retryPolicy.maxAttempts");
      expect(err?.message).toContain("impl");
      expect(err?.message).toContain("review");
    });

    it("accepts the same cycle once a node sets retryPolicy.maxAttempts", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("impl", "agent", agentConfig({ retryPolicy: { maxAttempts: 3 } })),
            node("review", "agent", agentConfig({ role: "reviewer" })),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "impl"),
            edge("e2", "impl", "review"),
            edge("e3", "review", "impl", 'review.status != "approved"'),
            edge("e4", "review", "end", 'review.status == "approved"'),
          ],
        ),
      );
      expect(result.errors).toEqual([]);
    });

    it("flags a self-loop with no retry limit and accepts a bounded one", () => {
      const unbounded = validateWorkflow(
        workflow(
          [node("start", "start"), node("cmd", "command", {}), node("end", "end")],
          [
            edge("e1", "start", "cmd"),
            edge("e2", "cmd", "cmd"),
            edge("e3", "cmd", "end"),
          ],
        ),
      );
      expect(codes(unbounded)).toContain(VALIDATION_CODES.UNBOUNDED_LOOP);

      const bounded = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("cmd", "command", { retryPolicy: { maxAttempts: 2 } }),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "cmd"),
            edge("e2", "cmd", "cmd"),
            edge("e3", "cmd", "end"),
          ],
        ),
      );
      expect(bounded.valid).toBe(true);
    });

    it("reports each unbounded cycle separately", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("a1", "command"),
            node("a2", "command"),
            node("b1", "command"),
            node("b2", "command"),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "a1"),
            edge("e2", "a1", "a2"),
            edge("e3", "a2", "a1"),
            edge("e4", "a2", "b1"),
            edge("e5", "b1", "b2"),
            edge("e6", "b2", "b1"),
            edge("e7", "b2", "end"),
          ],
        ),
      );
      expect(
        result.errors.filter((e) => e.code === VALIDATION_CODES.UNBOUNDED_LOOP),
      ).toHaveLength(2);
    });

    it("ignores a retryPolicy without a numeric maxAttempts", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("cmd", "command", { retryPolicy: {} })],
          [edge("e1", "start", "cmd"), edge("e2", "cmd", "cmd")],
        ),
      );
      expect(codes(result)).toContain(VALIDATION_CODES.UNBOUNDED_LOOP);
    });

    it("does not flag a diamond (non-cyclic) graph", () => {
      const result = validateWorkflow(
        workflow(
          [
            node("start", "start"),
            node("left", "command"),
            node("right", "command"),
            node("join", "condition"),
            node("end", "end"),
          ],
          [
            edge("e1", "start", "left"),
            edge("e2", "start", "right"),
            edge("e3", "left", "join"),
            edge("e4", "right", "join"),
            edge("e5", "join", "end"),
          ],
        ),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("duplicate ids", () => {
    it("flags duplicate node ids and duplicate edge ids", () => {
      const result = validateWorkflow(
        workflow(
          [node("start", "start"), node("end", "end"), node("end", "command")],
          [edge("e1", "start", "end"), edge("e1", "start", "end")],
        ),
      );
      expect(codes(result)).toEqual(
        expect.arrayContaining([
          VALIDATION_CODES.DUPLICATE_NODE_ID,
          VALIDATION_CODES.DUPLICATE_EDGE_ID,
        ]),
      );
    });
  });

  it("collects every problem instead of stopping at the first", () => {
    const result = validateWorkflow(
      workflow(
        [node("a", "agent", {}), node("orphan", "approval")],
        [edge("e1", "a", "missing", "a.b > 1")],
      ),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        VALIDATION_CODES.NO_START_NODE,
        VALIDATION_CODES.DANGLING_EDGE_TARGET,
        VALIDATION_CODES.INVALID_EDGE_CONDITION,
        VALIDATION_CODES.AGENT_MISSING_ROLE,
        VALIDATION_CODES.AGENT_MISSING_RUNTIME,
        VALIDATION_CODES.AGENT_MISSING_INSTRUCTIONS,
        VALIDATION_CODES.APPROVAL_NODE_NO_OUTGOING_EDGE,
      ]),
    );
  });

  it("handles an empty graph without throwing", () => {
    const result = validateWorkflow(workflow([], []));
    expect(codes(result)).toEqual([VALIDATION_CODES.NO_START_NODE]);
  });
});

describe("condition paths naming a multi-word agent", () => {
  it("accepts a hyphenated first segment, which is what an agent slug is", () => {
    // "Code Reviewer" slugs to `code-reviewer`; without this no condition could
    // ever refer to an agent whose name is more than one word.
    const parsed = parseEdgeCondition('code-reviewer.decision == "approved"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.condition.path).toEqual(["code-reviewer", "decision"]);
  });

  it("accepts hyphens anywhere in the path, not only at the front", () => {
    expect(parseEdgeCondition('a.some-field == "x"').ok).toBe(true);
  });

  it("still rejects a segment that starts or ends with a hyphen", () => {
    expect(parseEdgeCondition('-nope.decision == "x"').ok).toBe(false);
    expect(parseEdgeCondition('nope-.decision == "x"').ok).toBe(false);
  });

  it("still rejects a bare hyphen where a path should be", () => {
    expect(parseEdgeCondition('- == "x"').ok).toBe(false);
  });
});
