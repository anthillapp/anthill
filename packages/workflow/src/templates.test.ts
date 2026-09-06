import { describe, expect, it } from "vitest";

import { WORKFLOW_TEMPLATES, workflowTemplate } from "./templates.js";
import { agentConfig, validateWorkflow } from "./workflow.js";
import { compile } from "./compile.js";
import { agentProfiles, assignedAgents } from "./agents.js";
import { WORKFLOW_FORMAT_VERSION, workflowFormatVersion } from "./format.js";
import type { ActionKind } from "./actions.js";

/** The `actionKind` of every agent step in a template, in build order. */
function actionSequence(templateId: string): (ActionKind | undefined)[] {
  const workflow = workflowTemplate(templateId)!.build();
  return workflow.nodes
    .filter((node) => node.type === "agent")
    .map((node) => agentConfig(node).actionKind);
}

describe("workflow templates", () => {
  it("ships the six starter shapes", () => {
    expect(WORKFLOW_TEMPLATES.map((template) => template.id)).toEqual([
      "one-agent-solve",
      "brainstorm-to-workflow",
      "implement-test-fix",
      "consult-adversarial-decide",
      "multi-agent-coordination",
      "artifact-improvement",
    ]);
  });

  it("looks a template up by id", () => {
    expect(workflowTemplate("implement-test-fix")?.name).toBe("Implement, test, fix");
    expect(workflowTemplate("nope")).toBeUndefined();
  });

  // A template that opens with errors teaches the wrong thing about the tool.
  it.each(WORKFLOW_TEMPLATES)("$id validates cleanly as built", (template) => {
    const result = validateWorkflow(template.build());
    expect(result.errors).toEqual([]);
  });

  it.each(WORKFLOW_TEMPLATES)("$id compiles to a prompt", (template) => {
    const { prompt } = compile(template.build());
    expect(prompt).toContain("## Shared context");
    expect(prompt).toContain("## Steps");
    expect(prompt).toContain("How to read this workflow");
  });

  it.each(WORKFLOW_TEMPLATES)("$id is stamped with the current workflow format", (template) => {
    expect(workflowFormatVersion(template.build())).toBe(WORKFLOW_FORMAT_VERSION);
  });

  it.each(WORKFLOW_TEMPLATES)("$id builds a fresh workflow every time", (template) => {
    const first = template.build();
    const second = template.build();
    expect(first).not.toBe(second);
    first.nodes[0].name = "Changed";
    // Editing one workflow must not leak into the next one opened from the same
    // template.
    expect(second.nodes[0].name).not.toBe("Changed");
  });

  it("shows a one-agent workflow as one agent across several steps", () => {
    const agents = assignedAgents(workflowTemplate("one-agent-solve")!.build());
    expect(agents).toHaveLength(1);
    expect(agents[0].stepIds.length).toBeGreaterThan(1);
  });

  it("shows a multi-agent workflow as several agents", () => {
    const agents = assignedAgents(workflowTemplate("multi-agent-coordination")!.build());
    expect(agents.length).toBeGreaterThanOrEqual(4);
    // The coordinator both splits and integrates, so it owns two steps.
    const coordinator = agents.find((item) => item.profile.name === "Coordinator");
    expect(coordinator?.stepIds).toHaveLength(2);
  });

  it("carries an agent library every step of every template can resolve", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = template.build();
      const ids = new Set(agentProfiles(workflow).map((profile) => profile.id));
      const referenced = workflow.nodes
        .filter((node) => node.type === "agent")
        .map((node) => (node.config as Record<string, unknown>).agentId);
      expect(referenced.every((id) => typeof id === "string" && ids.has(id))).toBe(true);
    }
  });

  it("names no two agents the same within one template", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const names = agentProfiles(template.build()).map((profile) => profile.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("gives the implement/test/fix template a real loop with a bound", () => {
    const workflow = workflowTemplate("implement-test-fix")!.build();
    const { prompt } = compile(workflow);
    expect(prompt).toContain("## Loops");
    expect(prompt).toContain("passes");
  });

  it("delivers the workflow at the end of Brainstorm to approved workflow", () => {
    // The research chain ends "... -> Decompose -> Final Report"; this
    // template used to stop at Decompose with nothing after it.
    const sequence = actionSequence("brainstorm-to-workflow");
    expect(sequence).toContain("final-action");
    expect(sequence.at(-1)).toBe("final-action");

    const workflow = workflowTemplate("brainstorm-to-workflow")!.build();
    const deliver = workflow.nodes.find((node) => node.id === "deliver");
    expect(deliver).toBeDefined();
    // The delivery step must actually lead to End, not just exist.
    expect(
      workflow.edges.some((edge) => edge.source === "deliver" && edge.target === "end"),
    ).toBe(true);
  });

  it("opens with Research and closes with Present Recommendation in Consult, challenge, decide", () => {
    // The research chain is Research -> LLM Consult -> Adversarial Review ->
    // Approval Gate -> Present Recommendation; this template used to skip
    // both the research step and the recommendation it should produce.
    const workflow = workflowTemplate("consult-adversarial-decide")!.build();
    const agentSteps = workflow.nodes.filter((node) => node.type === "agent");

    expect(agentConfig(agentSteps[0]).actionKind).toBe("research");
    expect(agentConfig(agentSteps.at(-1) as (typeof agentSteps)[number]).actionKind).toBe(
      "present-recommendation",
    );

    // Wired in, not just present: research feeds the first real edge out of
    // Start, and the approval gate's "decided" path lands on the
    // recommendation rather than skipping straight to End.
    expect(workflow.edges.some((edge) => edge.source === "start" && edge.target === "research")).toBe(
      true,
    );
    const decide = workflow.nodes.find((node) => node.id === "decide");
    expect(decide).toBeDefined();
    const decidedEdge = workflow.edges.find(
      (edge) => edge.source === "decide" && edge.label === "decided",
    );
    expect(decidedEdge?.target).toBe("present");
    expect(
      workflow.edges.some((edge) => edge.source === "present" && edge.target === "end"),
    ).toBe(true);
  });

  it("describes when each template is the right one", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.summary.length).toBeGreaterThan(10);
      expect(template.whenToUse.length).toBeGreaterThan(20);
    }
  });
});
