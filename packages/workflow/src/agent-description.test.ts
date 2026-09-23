/**
 * What an agent's file says about the agent when nobody wrote it down.
 *
 * ANT-126. The description used to be the first step's purpose, or "The X in
 * this workflow." — a title, not a job. What is asserted here is that the
 * assembled one covers every step the agent owns, says how it works from the
 * fields the author did fill in, and invents nothing from the ones they did
 * not.
 */

import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";

import { MIN_DESCRIPTION_LENGTH, describeAgent, describesEnough } from "./agent-description.js";
import type { AgentProfile } from "./agents.js";

const qa: AgentProfile = {
  id: "agent-qa",
  name: "QA Operator",
  role: "Drives the native app through computer use and reports what it finds",
};

function step(id: string, name: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: "agent", name, config: { agentId: "agent-qa", ...config } };
}

function workflowWith(steps: WorkflowNode[], brief?: Workflow["brief"]): Workflow {
  return {
    id: "w",
    name: "QA the tickets",
    version: "1",
    target: "codex",
    ...(brief ? { brief } : {}),
    nodes: [{ id: "s", type: "start", name: "Start", config: {} }, ...steps],
    edges: [],
    metadata: { workflow: { formatVersion: 4, agents: [qa] } },
  };
}

describe("describing an agent from its steps", () => {
  it("opens with the role and the work's goal", () => {
    const text = describeAgent(qa, [], workflowWith([], { goal: "Every In Review ticket is checked." }));
    expect(text).toContain("QA Operator: Drives the native app through computer use and reports what it finds.");
    expect(text).toContain("The work it belongs to: every In Review ticket is checked.");
  });

  it("names every step the agent owns, in order, not only the first", () => {
    const steps = [
      step("prepare", "Prepare QA environment", { actionKind: "inspect-context", purpose: "Get the app running." }),
      step("qa-1", "QA ANT-121", { actionKind: "browser-check", task: "Exercise the routing case." }),
      step("report", "Compile QA report", { actionKind: "criteria-review", purpose: "Write it all up." }),
    ];
    const text = describeAgent(qa, steps, workflowWith(steps));
    expect(text).toContain("It carries out 3 steps, in this order:");
    expect(text).toContain("Prepare QA environment (inspect context) — get the app running");
    expect(text).toContain("QA ANT-121 (browser check) — exercise the routing case");
    expect(text).toContain("Compile QA report");
  });

  it("says what it reads, hands back and how it knows it is done", () => {
    const steps = [
      step("a", "Check", {
        actionKind: "browser-check",
        inputs: ["The ticket's acceptance criteria", "The running dev app"],
        expectedOutput: "A pass/fail verdict with screenshots. Then some detail.",
        successCriteria: ["Every criterion has evidence."],
        handoff: "The verdict goes to the report step.",
      }),
    ];
    const text = describeAgent(qa, steps, workflowWith(steps, { constraints: ["Never edit real user settings."] }));
    expect(text).toContain("Before starting a step it reads: The ticket's acceptance criteria; The running dev app.");
    expect(text).toContain("It hands back: A pass/fail verdict with screenshots.");
    expect(text).toContain("A step of its is done when: Every criterion has evidence.");
    expect(text).toContain("Throughout: Never edit real user settings.");
    expect(text).toContain("When a step is done it passes on: The verdict goes to the report step.");
  });

  it("says nothing about a field nobody filled in", () => {
    const steps = [step("a", "Check", { actionKind: "browser-check" })];
    const text = describeAgent(qa, steps, workflowWith(steps));
    expect(text).not.toContain("reads:");
    expect(text).not.toContain("hands back:");
    expect(text).not.toContain("done when:");
    expect(text).not.toContain("Throughout:");
  });

  it("counts a long list rather than reciting it", () => {
    const steps = Array.from({ length: 9 }, (_, i) =>
      step(`s${i}`, `Step ${i}`, { actionKind: "agent-step", successCriteria: [`Criterion ${i} holds.`] }),
    );
    const text = describeAgent(qa, steps, workflowWith(steps));
    expect(text).toContain("Criterion 5 holds; and 3 more.");
    expect(text).not.toContain("Criterion 8");
  });

  it("keeps an initialism as it was written", () => {
    const steps = [step("a", "QA ANT-1", { actionKind: "browser-check", purpose: "QA the ticket end to end." })];
    const text = describeAgent(qa, steps, workflowWith(steps, { goal: "QA the seven tickets." }));
    expect(text).toContain("The work it belongs to: QA the seven tickets.");
    expect(text).toContain("QA ANT-1 (browser check) — QA the ticket end to end.");
  });

  it("ends each list with one full stop, not each item's and its own", () => {
    const steps = [
      step("a", "A", { actionKind: "agent-step", constraints: ["Do not move ticket statuses.", "Stay on master."] }),
    ];
    const text = describeAgent(qa, steps, workflowWith(steps));
    expect(text).toContain("Throughout: Do not move ticket statuses; Stay on master.");
    expect(text).not.toContain("..");
  });

  it("does not repeat a criterion two steps share", () => {
    const steps = [
      step("a", "A", { actionKind: "agent-step", successCriteria: ["Tests pass."] }),
      step("b", "B", { actionKind: "agent-step", successCriteria: ["Tests pass."] }),
    ];
    const text = describeAgent(qa, steps, workflowWith(steps));
    expect(text.match(/Tests pass\./g)).toHaveLength(1);
  });

  it("is prose in paragraphs, not a form", () => {
    const steps = [step("a", "Check", { actionKind: "browser-check", expectedOutput: "A verdict." })];
    const text = describeAgent(qa, steps, workflowWith(steps, { goal: "Ship." }));
    expect(text.split("\n\n")).toHaveLength(3);
  });
});

describe("whether an author's description is enough", () => {
  it("refuses nothing, blanks and a title", () => {
    expect(describesEnough(undefined)).toBe(false);
    expect(describesEnough("   ")).toBe(false);
    expect(describesEnough("Handles the QA work.")).toBe(false);
  });

  it("accepts a full sentence", () => {
    const sentence =
      "Drives the app through each ticket's acceptance criteria, records evidence for every check, and hands back a verdict per ticket.";
    expect(sentence.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
    expect(describesEnough(sentence)).toBe(true);
  });
});
