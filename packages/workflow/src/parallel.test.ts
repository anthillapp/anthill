/**
 * Branches without conditions run side by side, and where they meet waits for
 * all of them (ANT-166). The diagram always looked that way; the prompt said
 * a numbered list out of Start and "otherwise … otherwise …" out of a step.
 */

import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@anthill/workflow-schema";

import { compile } from "./compile.js";
import { parallelPlan } from "./parallel.js";

const step = (id: string, name: string): WorkflowNode => ({
  id,
  type: "agent",
  name,
  config: { actionKind: "agent-step", agentId: "agent-dev", task: `Do ${name}.` },
});

function flow(
  steps: WorkflowNode[],
  edges: WorkflowEdge[],
  target: Workflow["target"] = "claude-code",
): Workflow {
  return {
    id: "flow",
    name: "Flow",
    version: "1",
    target,
    brief: { goal: "Get it done.", doneCriteria: ["It is done."] },
    metadata: { workflow: { agents: [{ id: "agent-dev", name: "Developer" }] } },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      ...steps,
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges,
  };
}

const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  ...extra,
});

/** Plan → (A ∥ B) → Merge → Done. */
const fanOutFromStep = () =>
  flow(
    [step("plan", "Plan"), step("a", "Service A"), step("b", "Service B"), step("merge", "Merge")],
    [
      edge("start", "plan"),
      edge("plan", "a"),
      edge("plan", "b"),
      edge("a", "merge"),
      edge("b", "merge"),
      edge("merge", "end"),
    ],
  );

describe("the parallel plan", () => {
  it("finds a fork and the join its branches meet at", () => {
    const plan = parallelPlan(fanOutFromStep());
    expect(plan.forks.get("plan")).toEqual(["a", "b"]);
    expect(plan.joins.get("merge")).toEqual(["a", "b"]);
    expect(plan.parallel("a", "b")).toBe(true);
    expect(plan.parallel("a", "merge")).toBe(false);
    expect(plan.parallel("plan", "a")).toBe(false);
  });

  it("does not call a choice a fork, nor where its paths meet a join", () => {
    const plan = parallelPlan(
      flow(
        [step("check", "Check"), step("a", "Path A"), step("b", "Path B"), step("merge", "Merge")],
        [
          edge("start", "check"),
          edge("check", "a", { condition: 'developer.decision == "a"' }),
          edge("check", "b"),
          edge("a", "merge"),
          edge("b", "merge"),
          edge("merge", "end"),
        ],
      ),
    );
    expect(plan.forks.size).toBe(0);
    expect(plan.joins.size).toBe(0);
    expect(plan.parallel("a", "b")).toBe(false);
  });

  it("keeps a rework loop inside its branch", () => {
    const plan = parallelPlan(
      flow(
        [step("a", "Build A"), step("testA", "Test A"), step("fixA", "Fix A"), step("b", "Build B"), step("merge", "Integrate")],
        [
          edge("start", "a"),
          edge("start", "b"),
          edge("a", "testA"),
          edge("testA", "fixA", { kind: "rework", condition: 'tester.decision == "failed"' }),
          edge("fixA", "testA"),
          edge("testA", "merge", { label: "passed" }),
          edge("b", "merge"),
          edge("merge", "end"),
        ],
      ),
    );
    expect(plan.forks.get("start")).toEqual(["a", "b"]);
    expect(plan.forks.has("testA")).toBe(false);
    expect(plan.joins.get("merge")?.sort()).toEqual(["b", "testA"]);
    expect(plan.parallel("fixA", "b")).toBe(true);
  });
});

describe("the compiled prompt", () => {
  const stepsOf = (workflow: Workflow) => compile(workflow).prompt.split("## Steps")[1].split("## Rules")[0];

  it("starts every branch of a step's fork at once, with no choice between them", () => {
    const steps = stepsOf(fanOutFromStep());
    expect(steps).toContain(
      "Then continue to steps 2 (Service A) and 3 (Service B) at the same time – they are independent. Hand each to its own subagent in one go",
    );
    expect(steps).not.toContain("otherwise");
  });

  it("makes the step where they meet wait for both", () => {
    const steps = stepsOf(fanOutFromStep());
    const merge = steps.slice(steps.indexOf("### 4. Merge"));
    expect(merge).toContain(
      "Start this step only once step 2 (Service A) and step 3 (Service B) are both finished – they run in parallel and meet here.",
    );
  });

  it("starts branches out of Start at once, where there is no step to say it", () => {
    const steps = stepsOf(
      flow(
        [step("a", "Service A"), step("b", "Service B"), step("merge", "Merge")],
        [edge("start", "a"), edge("start", "b"), edge("a", "merge"), edge("b", "merge"), edge("merge", "end")],
      ),
    );
    expect(steps).toContain("To begin, continue to steps 1 (Service A) and 2 (Service B) at the same time");
  });

  it("does not let one branch reaching the end end the workflow", () => {
    const steps = stepsOf(
      flow(
        [step("a", "Service A"), step("b", "Service B")],
        [edge("start", "a"), edge("start", "b"), edge("a", "end"), edge("b", "end")],
      ),
    );
    expect(steps).toContain("stop – this branch is finished; the workflow is complete (Done) once every parallel branch is");
    expect(steps).not.toContain("Then stop – the workflow is complete (Done).");
  });

  it("leaves a choice as a choice", () => {
    const steps = stepsOf(
      flow(
        [step("check", "Check"), step("a", "Path A"), step("b", "Path B")],
        [
          edge("start", "check"),
          edge("check", "a", { condition: 'developer.decision == "a"', label: "a" }),
          edge("check", "b", { label: "otherwise" }),
          edge("a", "end"),
          edge("b", "end"),
        ],
      ),
    );
    expect(steps).toContain("- if");
    expect(steps).toContain("- otherwise");
    expect(steps).not.toContain("at the same time");
    expect(steps).not.toContain("Start this step only once");
  });

  it("says the branches may be taken in any order where there are no subagents to run them", () => {
    const workflow = fanOutFromStep();
    const steps = stepsOf({ ...workflow, target: "pi" });
    expect(steps).toContain("continue to steps 2 (Service A) and 3 (Service B) – they are independent, so do all of them");
  });

  it("qualifies the in-order rule only where something runs in parallel", () => {
    expect(compile(fanOutFromStep()).prompt).toContain("steps marked to run at the same time start together");
    const sequential = flow(
      [step("a", "A"), step("b", "B")],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );
    expect(compile(sequential).prompt).toContain("- Follow the steps in the order given; do not skip ahead.");
  });
});
