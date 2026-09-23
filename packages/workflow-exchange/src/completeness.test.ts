/**
 * What has to be true before a workflow may be handed over.
 *
 * The cases worth holding onto are the ones where this differs from the canvas:
 * an advisory is a refusal here, done criteria are required whether or not the
 * graph loops, and the handover itself can be wrong — the wrong tool, or no
 * record of what the user asked for — while the diagram is perfectly good.
 */

import {
  WORKFLOWNER_ADVISORY_CODES,
  WORKFLOWNER_VALIDATION_CODES,
} from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import { describe, expect, it } from "vitest";

import { askFor, checkCompleteness } from "./completeness.js";
import { EXCHANGE_PROBLEM_CODES, type ExchangeSource } from "./contracts.js";

const SOURCE: ExchangeSource = {
  harness: "claude-code",
  sessionId: "session-abc",
  taskText: "Fix the crash on startup.",
};

/** A workflow with nothing left to ask about: the baseline every case bends. */
function completeWorkflow(): Workflow {
  return {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    target: "claude-code",
    brief: {
      goal: "The startup crash is fixed and covered by a test.",
      doneCriteria: ["The test suite passes.", "The crash no longer reproduces."],
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      {
        id: "step-1",
        type: "agent",
        name: "Fix it",
        config: {
          actionKind: "implement",
          task: "Find the cause of the startup crash and fix it.",
          agentId: "agent-1",
          expectedOutput: "A patch, and a test that fails without it.",
          successCriteria: ["The new test fails on the old code."],
        },
      },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "edge-1", source: "start", target: "step-1" },
      { id: "edge-2", source: "step-1", target: "end" },
    ],
    metadata: {
      workflow: {
        agents: [
          {
            id: "agent-1",
            name: "Developer",
            description:
              "Finds the cause of the startup crash from the stack trace and the boot sequence, fixes it with the smallest change that holds, and hands back the patch with a test that fails without it.",
            models: { "claude-code": { id: "sonnet" } },
          },
        ],
      },
    },
  };
}

function codes(workflow: Workflow, source: ExchangeSource = SOURCE): string[] {
  return checkCompleteness(workflow, source).map((problem) => problem.code);
}

describe("checkCompleteness", () => {
  it("finds nothing to ask about a complete workflow", () => {
    expect(checkCompleteness(completeWorkflow(), SOURCE)).toEqual([]);
  });

  it("gives every problem a question to put to the user", () => {
    // A deliberately empty workflow, so most of the vocabulary fires at once.
    const bare: Workflow = { id: "w", name: "", version: "0.1.0", nodes: [], edges: [] };
    const problems = checkCompleteness(bare, { ...SOURCE, taskText: "" });

    expect(problems.length).toBeGreaterThan(3);
    for (const problem of problems) {
      expect(problem.message, problem.code).toBeTruthy();
      expect(problem.ask, problem.code).toBeTruthy();
      expect(problem.ask, problem.code).toContain("?");
      // The question is written for the user, not assembled from the
      // validator's sentence — the fallback does that, and reaching it means
      // somebody added a rule and no question.
      expect(problem.ask, problem.code).not.toContain(problem.message);
    }
  });

  it("has a question written for every code it can report", () => {
    const reportable = [
      ...Object.values(WORKFLOWNER_VALIDATION_CODES),
      ...Object.values(WORKFLOWNER_ADVISORY_CODES),
      EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA,
      EXCHANGE_PROBLEM_CODES.HANDOVER_NO_TASK_TEXT,
      EXCHANGE_PROBLEM_CODES.HANDOVER_TARGET_MISMATCH,
    ];

    for (const code of reportable) {
      expect(askFor(code), code).toBeTruthy();
      expect(askFor(code), code).toContain("?");
    }
  });

  /*
    ANT-126. An agent handed over with a name and a one-line role opened its
    file with nothing about how to work. The editor advises; a handover asks.
  */
  it("refuses an agent with no description, and asks how it should work", () => {
    const workflow = completeWorkflow();
    const agents = (workflow.metadata as { workflow: { agents: { description?: string }[] } })
      .workflow.agents;
    delete agents[0].description;

    const problems = checkCompleteness(workflow, SOURCE);
    expect(problems.map((problem) => problem.code)).toEqual([
      WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION,
    ]);
    expect(problems[0].ask).toMatch(/how should this agent/i);
  });

  it("refuses a description too short to be one", () => {
    const workflow = completeWorkflow();
    const agents = (workflow.metadata as { workflow: { agents: { description?: string }[] } })
      .workflow.agents;
    agents[0].description = "Handles the dev work.";
    expect(codes(workflow)).toEqual([WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION]);
  });

  it("refuses a workflow with no goal, which the editor only advises about", () => {
    const workflow = completeWorkflow();
    delete workflow.brief?.goal;
    expect(codes(workflow)).toEqual([WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL]);
  });

  it("refuses a step that never says what it produces or how to tell it worked", () => {
    const workflow = completeWorkflow();
    const step = workflow.nodes[1];
    if (step) step.config = { ...step.config, expectedOutput: undefined, successCriteria: [] };

    expect(codes(workflow)).toEqual([
      WORKFLOWNER_ADVISORY_CODES.STEP_NO_EXPECTED_OUTPUT,
      WORKFLOWNER_ADVISORY_CODES.STEP_NO_SUCCESS_CRITERIA,
    ]);
  });

  it("requires done criteria even where the workflow does not loop", () => {
    const workflow = completeWorkflow();
    delete workflow.brief?.doneCriteria;

    const problems = checkCompleteness(workflow, SOURCE);
    expect(problems.map((problem) => problem.code)).toEqual([
      EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA,
    ]);
    expect(problems[0]?.ask).toContain("done");
    expect(problems[0]?.field).toBe("workflow.brief.doneCriteria");
  });

  it("treats blank done criteria as none at all", () => {
    const workflow = completeWorkflow();
    if (workflow.brief) workflow.brief.doneCriteria = ["   "];
    expect(codes(workflow)).toEqual([EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA]);
  });

  it("asks about missing done criteria once when the workflow also loops", () => {
    const workflow = completeWorkflow();
    delete workflow.brief?.doneCriteria;
    // A step that comes back to itself: the validator's loop rule and the
    // handover's rule are then the same sentence.
    workflow.edges.push({ id: "edge-3", source: "step-1", target: "step-1" });

    const reported = codes(workflow);
    expect(reported).toContain(WORKFLOWNER_VALIDATION_CODES.LOOP_WITHOUT_DONE_CRITERIA);
    expect(reported).not.toContain(EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA);
  });

  it("refuses a handover that does not carry what the user asked for", () => {
    const problems = checkCompleteness(completeWorkflow(), { ...SOURCE, taskText: "   " });
    expect(problems.map((problem) => problem.code)).toEqual([
      EXCHANGE_PROBLEM_CODES.HANDOVER_NO_TASK_TEXT,
    ]);
    expect(problems[0]?.field).toBe("source.taskText");
  });

  it("refuses a workflow written for a different tool than the one handing it over", () => {
    const problems = checkCompleteness(completeWorkflow(), { ...SOURCE, harness: "codex" });
    const mismatch = problems.find(
      (problem) => problem.code === EXCHANGE_PROBLEM_CODES.HANDOVER_TARGET_MISMATCH,
    );

    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain("Claude Code");
    expect(mismatch?.message).toContain("Codex");
    expect(mismatch?.field).toBe("workflow.target");
  });

  it("does not report a mismatch when the workflow names no tool at all", () => {
    const workflow = completeWorkflow();
    delete workflow.target;

    const reported = codes(workflow);
    expect(reported).toContain(WORKFLOWNER_VALIDATION_CODES.NO_TARGET);
    expect(reported).not.toContain(EXCHANGE_PROBLEM_CODES.HANDOVER_TARGET_MISMATCH);
  });

  it("refuses a step assigned to an agent the workflow does not have", () => {
    const workflow = completeWorkflow();
    const step = workflow.nodes[1];
    if (step) step.config = { ...step.config, agentId: "agent-9" };

    const problems = checkCompleteness(workflow, SOURCE);
    const unknown = problems.find(
      (problem) => problem.code === WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT,
    );
    expect(unknown?.nodeId).toBe("step-1");
    expect(unknown?.ask).toBeTruthy();
  });

  it("keeps the connection a problem is about, which is its only locator", () => {
    const workflow = completeWorkflow();
    workflow.edges.push({ id: "edge-3", source: "step-1", target: "nowhere" });

    const problems = checkCompleteness(workflow, SOURCE);
    const dangling = problems.find(
      (problem) => problem.code === WORKFLOWNER_VALIDATION_CODES.DANGLING_CONNECTION,
    );
    expect(dangling?.edgeId).toBe("edge-3");
    expect(dangling?.nodeId).toBeUndefined();
  });

  it("keeps the validator's own wording, and points at the step", () => {
    const workflow = completeWorkflow();
    const step = workflow.nodes[1];
    if (step) step.config = { ...step.config, task: undefined };

    const problems = checkCompleteness(workflow, SOURCE);
    const missing = problems.find(
      (problem) => problem.code === WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK,
    );
    expect(missing?.message).toBe(
      "Describe what this step must do — an empty task produces an empty prompt.",
    );
    expect(missing?.nodeId).toBe("step-1");
  });

  it("puts the handover's own questions before the diagram's", () => {
    const workflow = completeWorkflow();
    delete workflow.brief?.goal;

    const reported = codes(workflow, { ...SOURCE, taskText: "" });
    expect(reported[0]).toBe(EXCHANGE_PROBLEM_CODES.HANDOVER_NO_TASK_TEXT);
  });
});

/**
 * Acceptance: one graph, two hosts, the same answer.
 *
 * ANT-86 promises that a workflow with branches, controlled loops and agents
 * assigned by reference is judged the same whichever coding tool hands it
 * over. Everything in `checkCompleteness` is about the diagram and the
 * handover rather than about the tool — except the two rules that name one:
 * a workflow must target the tool submitting it, and an agent must have an
 * answer for that tool. So the graph is submitted twice, once as each host,
 * differing only in those two answers, and the problems are compared whole.
 */
describe("the same graph, handed over by either host", () => {
  /** Triage, then implement and review round a bounded loop, then ship. */
  function representative(target: "claude-code" | "codex"): Workflow {
    return {
      id: "workflow-2",
      name: "Land the fix",
      version: "0.1.0",
      target,
      brief: {
        goal: "The reported crash is fixed, reviewed and released.",
        doneCriteria: ["The reviewer approves.", "The suite passes."],
      },
      nodes: [
        { id: "start", type: "start", name: "Start", config: {} },
        {
          id: "triage",
          type: "agent",
          name: "Triage",
          config: {
            actionKind: "research",
            task: "Work out what is actually broken and whether it is worth fixing.",
            agentId: "agent-lead",
            expectedOutput: "A cause, and a decision to fix or to close.",
            successCriteria: ["The cause names a file and a line."],
          },
        },
        {
          id: "implement",
          type: "agent",
          name: "Implement",
          config: {
            actionKind: "implement",
            task: "Fix the cause triage found, with a test that fails without the fix.",
            agentId: "agent-dev",
            expectedOutput: "A patch, and a failing-first test.",
            successCriteria: ["The new test fails on the old code."],
            maxIterations: 3,
          },
        },
        {
          id: "review",
          type: "agent",
          name: "Review",
          config: {
            actionKind: "llm-review",
            task: 'Read the diff. Answer "approved" or "changes_requested".',
            agentId: "agent-rev",
            expectedOutput: "A decision, and the reasons for it.",
            successCriteria: ["Every reason points at a line of the diff."],
            maxIterations: 3,
          },
        },
        { id: "closed", type: "end", name: "Closed without a fix", config: {} },
        { id: "shipped", type: "end", name: "Shipped", config: {} },
      ],
      edges: [
        { id: "edge-1", source: "start", target: "triage" },
        // A branch, with the unconditional way out that every branch needs.
        {
          id: "edge-2",
          source: "triage",
          target: "closed",
          condition: 'lead.decision == "not_worth_fixing"',
          label: "not worth fixing",
        },
        { id: "edge-3", source: "triage", target: "implement", label: "worth fixing" },
        { id: "edge-4", source: "implement", target: "review" },
        // The loop, bounded by the maxIterations on both of its blocks.
        {
          id: "edge-5",
          source: "review",
          target: "implement",
          condition: 'reviewer.decision == "changes_requested"',
          label: "changes requested",
        },
        { id: "edge-6", source: "review", target: "shipped", label: "approved" },
      ],
      metadata: {
        workflow: {
          agents: [
            {
              id: "agent-lead",
              name: "Lead",
              description:
                "Reads the request and the codebase, decides how the work splits, and hands the developer a plan with the files each step touches.",
              models: { "claude-code": { id: "opus" }, codex: { id: "gpt-5-codex" } },
            },
            {
              id: "agent-dev",
              name: "Developer",
              description:
                "Carries out the plan step by step, keeps each diff small enough to review, and hands back the change with the tests that prove it.",
              models: {
                "claude-code": { id: "sonnet" },
                codex: { id: "gpt-5-codex", reasoningEffort: "medium" },
              },
            },
            {
              id: "agent-rev",
              name: "Reviewer",
              description:
                "Reads each diff against the plan and the done criteria, asks for changes where they are not met, and approves only when every criterion holds.",
              models: { "claude-code": { id: "opus" }, codex: { id: "gpt-5-codex" } },
            },
          ],
        },
      },
    };
  }

  function asHost(harness: "claude-code" | "codex"): ExchangeSource {
    return { ...SOURCE, harness };
  }

  it("finds nothing to ask either host about", () => {
    expect(checkCompleteness(representative("claude-code"), asHost("claude-code"))).toEqual([]);
    expect(checkCompleteness(representative("codex"), asHost("codex"))).toEqual([]);
  });

  it("asks both hosts the same questions about the same damage", () => {
    const damage = (workflow: Workflow): Workflow => {
      // One of each kind the graph is representative of: a step with no task,
      // a loop nobody bounded, and a branch that reads a result from an agent
      // this workflow does not have.
      const [, , implement, review] = workflow.nodes;
      implement.config = { ...implement.config, task: "  " };
      review.config = { ...review.config, maxIterations: undefined };
      workflow.edges[1].condition = 'nobody.decision == "not_worth_fixing"';
      return workflow;
    };

    const claude = checkCompleteness(damage(representative("claude-code")), asHost("claude-code"));
    const codex = checkCompleteness(damage(representative("codex")), asHost("codex"));

    expect(claude.map((problem) => problem.code)).toEqual([
      WORKFLOWNER_VALIDATION_CODES.CONDITION_UNKNOWN_AGENT,
      WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK,
      WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP,
    ]);
    expect(codex).toEqual(claude);
  });
});
