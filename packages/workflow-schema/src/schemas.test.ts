import { describe, expect, it } from "vitest";

import {
  AgentNodeConfigSchema,
  AgentResultSchema,
  ArtifactSchema,
  RunMetricsSchema,
  SchemaValidationError,
  WorkflowRunSchema,
  WorkflowSchema,
  parseAgentNodeConfig,
  parseAgentResult,
  parseWorkflow,
  parseWorkflowRun,
} from "./schemas.js";
import type { AgentResult, Workflow, WorkflowRun } from "./types.js";

const minimalWorkflow = {
  id: "wf_1",
  name: "Minimal",
  version: "1.0.0",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    { id: "end", type: "end", name: "End", config: {} },
  ],
  edges: [{ id: "e1", source: "start", target: "end" }],
};

describe("WorkflowSchema / parseWorkflow", () => {
  it("parses a minimal workflow", () => {
    const workflow: Workflow = parseWorkflow(minimalWorkflow);
    expect(workflow.id).toBe("wf_1");
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.edges[0]?.source).toBe("start");
  });

  it("rejects a node id with whitespace (not reportable by the progress channels)", () => {
    const wf = {
      ...minimalWorkflow,
      nodes: [
        { ...minimalWorkflow.nodes[0], id: "code review" },
        minimalWorkflow.nodes[1],
      ],
    };
    expect(() => parseWorkflow(wf)).toThrow(SchemaValidationError);
  });

  it("accepts node ids using the full reportable character class", () => {
    const wf = {
      ...minimalWorkflow,
      nodes: [
        { ...minimalWorkflow.nodes[0], id: "code.review:1" },
        { ...minimalWorkflow.nodes[1], id: "deploy_to:prod" },
      ],
    };
    expect(() => parseWorkflow(wf)).not.toThrow();
  });

  it("parses a full workflow with inputs, positions, conditions and metadata", () => {
    const workflow = parseWorkflow({
      id: "wf_2",
      name: "Review flow",
      description: "Implement then review",
      version: "2.1.0",
      inputs: [
        { name: "ticket", type: "string", description: "id", required: true },
        { name: "budget", type: "number", default: 5 },
        { name: "dryRun", type: "boolean" },
        { name: "payload", type: "json", default: { a: 1 } },
      ],
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          config: {},
          position: { x: 0, y: 0 },
        },
        {
          id: "impl",
          type: "agent",
          name: "Implementer",
          config: {
            role: "implementer",
            runtime: "codex-cli",
            instructions: "Do the thing",
          },
          position: { x: 100, y: 20 },
        },
        { id: "gate", type: "approval", name: "Gate", config: {} },
        { id: "cond", type: "condition", name: "Cond", config: {} },
        { id: "cmd", type: "command", name: "Cmd", config: { command: "npm test" } },
        { id: "end", type: "end", name: "End", config: {} },
      ],
      edges: [
        { id: "e1", source: "start", target: "impl" },
        { id: "e2", source: "impl", target: "gate", label: "review" },
        {
          id: "e3",
          source: "gate",
          target: "cond",
          condition: 'review.status == "approved"',
        },
        { id: "e4", source: "cond", target: "cmd" },
        { id: "e5", source: "cmd", target: "end" },
      ],
      metadata: { author: "nstr", tags: ["mvp"] },
    });

    expect(workflow.inputs).toHaveLength(4);
    expect(workflow.metadata?.author).toBe("nstr");
    expect(workflow.nodes[1]?.position).toEqual({ x: 100, y: 20 });
  });

  it("rejects a workflow missing required fields", () => {
    expect(() => parseWorkflow({ id: "wf", name: "x" })).toThrow(
      SchemaValidationError,
    );
  });

  it("rejects an unknown node type with a descriptive message", () => {
    let message = "";
    try {
      parseWorkflow({
        ...minimalWorkflow,
        nodes: [{ id: "n1", type: "wizard", name: "n", config: {} }],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Invalid workflow");
    expect(message).toContain("nodes.0.type");
  });

  it("rejects empty ids and non-array nodes", () => {
    expect(() =>
      parseWorkflow({ ...minimalWorkflow, id: "" }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      parseWorkflow({ ...minimalWorkflow, nodes: "nope" }),
    ).toThrow(SchemaValidationError);
  });

  it("rejects a bad workflow input type", () => {
    expect(() =>
      parseWorkflow({
        ...minimalWorkflow,
        inputs: [{ name: "x", type: "date" }],
      }),
    ).toThrow(SchemaValidationError);
  });

  it("exposes zod issues on the thrown error", () => {
    try {
      parseWorkflow({ ...minimalWorkflow, version: "" });
      throw new Error("expected parseWorkflow to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  /**
   * A field this build does not know about survives being opened (ANT-103).
   *
   * It used to be stripped, so the next Save wrote the document back without
   * it — silently, and permanently. Rejecting the file instead would make a
   * document that opens everywhere else unopenable here over a field nobody
   * needs to read.
   */
  it("keeps unknown top-level keys instead of dropping them", () => {
    const workflow = parseWorkflow({ ...minimalWorkflow, bogus: true });
    expect((workflow as Record<string, unknown>).bogus).toBe(true);
  });

  it("keeps unknown keys nested inside a node or an edge", () => {
    const workflow = parseWorkflow({
      ...minimalWorkflow,
      nodes: minimalWorkflow.nodes.map((node) => ({ ...node, vendorHint: { colour: "red" } })),
      edges: minimalWorkflow.edges.map((edge) => ({ ...edge, vendorLabel: "later" })),
    });
    const [node] = workflow.nodes as unknown as Record<string, unknown>[];
    const [edge] = workflow.edges as unknown as Record<string, unknown>[];
    expect(node.vendorHint).toEqual({ colour: "red" });
    expect(edge.vendorLabel).toBe("later");
  });

  it("round-trips a document with extra fields unchanged", () => {
    const extended = {
      ...minimalWorkflow,
      bogus: true,
      nodes: minimalWorkflow.nodes.map((node) => ({ ...node, vendorHint: 1 })),
    };
    // Open, then save, then open again: what a user does without thinking
    // about it, and where the loss used to happen.
    const once = parseWorkflow(extended);
    const twice = parseWorkflow(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect((twice as Record<string, unknown>).bogus).toBe(true);
  });

  it("still refuses a document whose known fields are wrong", () => {
    // Keeping what it does not recognise is not the same as accepting
    // anything: every known field is validated exactly as before.
    expect(() => parseWorkflow({ ...minimalWorkflow, extra: true, nodes: "not an array" }))
      .toThrow(SchemaValidationError);
  });

  it("safeParse reports success for valid input", () => {
    expect(WorkflowSchema.safeParse(minimalWorkflow).success).toBe(true);
  });
});

describe("AgentNodeConfigSchema", () => {
  const base = {
    role: "reviewer",
    runtime: "claude-code",
    instructions: "Review the diff",
  };

  it("parses a minimal config", () => {
    expect(parseAgentNodeConfig(base).role).toBe("reviewer");
  });

  it("parses a full config", () => {
    const config = parseAgentNodeConfig({
      ...base,
      agentId: "agent_1",
      model: "opus",
      inputs: { diff: "impl.artifacts.patch" },
      outputs: { type: "object", properties: { verdict: { type: "string" } } },
      tools: ["bash", "read"],
      permissions: {
        readOnly: true,
        editFiles: false,
        runCommands: false,
        networkAllowed: false,
        requireApprovalForDestructive: true,
      },
      workingDirectory: "/tmp/wt",
      successCriteria: "no critical issues",
      retryPolicy: { maxAttempts: 3, backoffMs: 500 },
    });
    expect(config.retryPolicy?.maxAttempts).toBe(3);
    expect(config.permissions?.readOnly).toBe(true);
    expect(config.tools).toEqual(["bash", "read"]);
  });

  it("rejects empty role / runtime / instructions", () => {
    expect(() => parseAgentNodeConfig({ ...base, role: "" })).toThrow();
    expect(() => parseAgentNodeConfig({ ...base, runtime: "" })).toThrow();
    expect(() => parseAgentNodeConfig({ ...base, instructions: "" })).toThrow();
  });

  it("rejects a non-integer maxAttempts", () => {
    expect(
      AgentNodeConfigSchema.safeParse({
        ...base,
        retryPolicy: { maxAttempts: 1.5 },
      }).success,
    ).toBe(false);
  });

  it("rejects non-string values in inputs", () => {
    expect(
      AgentNodeConfigSchema.safeParse({ ...base, inputs: { a: 1 } }).success,
    ).toBe(false);
  });
});

describe("AgentResultSchema", () => {
  const result = {
    status: "success",
    summary: "done",
    artifacts: [{ id: "a1", type: "patch", title: "Patch" }],
    issues: [{ severity: "high", title: "Missing tests" }],
    metadata: {},
  };

  it("parses a valid result", () => {
    const parsed: AgentResult = parseAgentResult(result);
    expect(parsed.artifacts[0]?.type).toBe("patch");
    expect(parsed.issues[0]?.severity).toBe("high");
  });

  it("accepts an arbitrary artifact type string", () => {
    expect(
      ArtifactSchema.safeParse({ id: "a", type: "deployment_note", title: "t" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown status and an unknown severity", () => {
    expect(
      AgentResultSchema.safeParse({ ...result, status: "kinda" }).success,
    ).toBe(false);
    expect(
      AgentResultSchema.safeParse({
        ...result,
        issues: [{ severity: "spicy", title: "t" }],
      }).success,
    ).toBe(false);
  });

  it("requires artifacts, issues and metadata", () => {
    expect(() => parseAgentResult({ status: "success", summary: "s" })).toThrow(
      SchemaValidationError,
    );
  });

  it("keeps unknown metrics keys (open-ended RunMetrics)", () => {
    const metrics = RunMetricsSchema.parse({
      durationMs: 1200,
      tokensUsed: 900,
      filesChanged: 3,
      cacheHits: 7,
    });
    expect(metrics.durationMs).toBe(1200);
    expect(metrics.cacheHits).toBe(7);
  });

  it("rejects a non-numeric durationMs", () => {
    expect(RunMetricsSchema.safeParse({ durationMs: "fast" }).success).toBe(false);
  });
});

describe("WorkflowRunSchema", () => {
  const run = {
    id: "run_1",
    workflowId: "wf_1",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: "2026-08-25T10:00:00.000Z",
    nodeRuns: [
      {
        id: "nr_1",
        nodeId: "impl",
        attempt: 1,
        status: "success",
        startedAt: "2026-08-25T10:00:01.000Z",
        finishedAt: "2026-08-25T10:00:09.000Z",
        result: {
          status: "success",
          summary: "ok",
          artifacts: [],
          issues: [],
          metadata: {},
        },
        logs: [{ id: "log_1", path: "runs/run_1/nr_1.log", kind: "stdout" }],
      },
    ],
  };

  it("parses a run with node runs, results and logs", () => {
    const parsed: WorkflowRun = parseWorkflowRun(run);
    expect(parsed.nodeRuns[0]?.result?.status).toBe("success");
    expect(parsed.nodeRuns[0]?.logs?.[0]?.kind).toBe("stdout");
  });

  it("rejects an invalid run status", () => {
    expect(WorkflowRunSchema.safeParse({ ...run, status: "done" }).success).toBe(
      false,
    );
  });

  it("rejects a node run with a negative attempt", () => {
    expect(
      WorkflowRunSchema.safeParse({
        ...run,
        nodeRuns: [{ ...run.nodeRuns[0], attempt: -1 }],
      }).success,
    ).toBe(false);
  });
});
