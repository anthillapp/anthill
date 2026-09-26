import { describe, expect, it } from "vitest";
import type { AgentResult, AgentRunContext } from "./contracts.js";
import { buildPromptEnvelope } from "./prompt-envelope.js";

const priorResult: AgentResult = {
  status: "success",
  summary: "Planned the migration.",
  artifacts: [{ id: "workflow-1", type: "note", title: "Workflow" }],
  issues: [],
  metadata: {},
};

const ctx: AgentRunContext = {
  runId: "run-9",
  nodeId: "node-implement",
  attempt: 1,
  workingDirectory: "/srv/workspaces/run-9",
  instructions: "Apply the migration workflow.",
  role: "Implementer",
  priorResults: { "node-workflow": priorResult },
};

describe("buildPromptEnvelope", () => {
  it("emits every section in the documented order", () => {
    const prompt = buildPromptEnvelope(ctx);

    const sections = ["Role:", "Task:", "Workspace:", "Prior Results:", "Expected Output:"];
    const positions = sections.map((section) => prompt.indexOf(section));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt.startsWith("You are running as part of an Anthill workflow.")).toBe(true);
  });

  it("interpolates the context values", () => {
    const prompt = buildPromptEnvelope(ctx);

    expect(prompt).toContain("Implementer");
    expect(prompt).toContain("Apply the migration workflow.");
    expect(prompt).toContain("/srv/workspaces/run-9");
    expect(prompt).toContain("Planned the migration.");
  });

  it("serializes prior results as pretty JSON", () => {
    const prompt = buildPromptEnvelope(ctx);

    expect(prompt).toContain(JSON.stringify({ "node-workflow": priorResult }, null, 2));
  });

  it("uses an empty object when there are no prior results", () => {
    const prompt = buildPromptEnvelope({ ...ctx, priorResults: undefined });

    expect(prompt).toContain("Prior Results:\n{}\n");
  });

  it("includes a parseable example of the AgentResult shape", () => {
    const prompt = buildPromptEnvelope(ctx);
    const marker = "Return JSON matching this schema:\n";
    const example = prompt.slice(prompt.indexOf(marker) + marker.length).trim();

    expect(() => JSON.parse(example) as unknown).not.toThrow();
    const parsed = JSON.parse(example) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "status",
      "summary",
      "decision",
      "artifacts",
      "issues",
      "metrics",
      "metadata",
    ]);
  });

  it("is pure – identical contexts produce identical prompts", () => {
    expect(buildPromptEnvelope(ctx)).toBe(buildPromptEnvelope({ ...ctx }));
  });
});
