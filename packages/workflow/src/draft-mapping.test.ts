import { describe, expect, it } from "vitest";

import { agentProfiles, assignedAgents, stepsUsingAgent } from "./agents.js";
import { WORKFLOWNER_DRAFT_VERSION, type WorkflowDraft } from "./draft.js";
import { mapDraftToWorkflow, workflowSource, reviewDraft } from "./draft-mapping.js";
import { agentConfig, validateWorkflow } from "./workflow.js";
import { outputsOf } from "./outputs.js";
import { compile } from "./compile.js";
import { WORKFLOW_FORMAT_VERSION } from "./format.js";

const OPTIONS = {
  prompt: "Build the thing and check it works.",
  interpreter: "claude-code" as const,
  command: "claude -p --tools ''",
  now: () => new Date("2026-08-28T12:00:00.000Z"),
};

/** One agent doing two steps with a loop back — the shape most drafts take. */
function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    draftVersion: WORKFLOWNER_DRAFT_VERSION,
    title: "Implement and verify",
    summary: "Build it, then check it.",
    brief: {
      goal: "The feature works.",
      doneCriteria: ["Tests pass."],
    },
    agents: [
      { id: "dev", name: "Developer", model: "opus", role: "Builds it" },
      { id: "qa", name: "Tester", description: "Runs the suite honestly." },
    ],
    steps: [
      {
        id: "implement",
        name: "Implement",
        kind: "step",
        agent: "dev",
        action: "agent-step",
        task: "Make the change.",
        maxIterations: 3,
        outputs: [{ to: "verify", kind: "next", label: "ready" }],
      },
      {
        id: "verify",
        name: "Run tests",
        kind: "step",
        agent: "qa",
        action: "run-tests",
        task: "Run the suite.",
        maxIterations: 3,
        outputs: [
          { to: "fix", kind: "rework", label: "failed", condition: 'tester.decision == "failed"' },
          { to: "end", kind: "next", label: "passed" },
        ],
      },
      {
        id: "fix",
        name: "Fix failures",
        kind: "step",
        agent: "dev",
        action: "agent-step",
        task: "Fix what failed.",
        maxIterations: 3,
        outputs: [{ to: "verify", kind: "next", label: "re-run" }],
      },
    ],
    questions: [
      {
        id: "cmd",
        question: "Which test command should be used?",
        about: { kind: "step", stepId: "verify" },
        options: [],
      },
    ],
    ...overrides,
  };
}

describe("mapping a draft onto a workflow", () => {
  it("produces a workflow that validates as it stands", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it("produces a workflow that compiles", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(() => compile(workflow)).not.toThrow();
  });

  it("starts the workflow at the draft's first step", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const fromStart = workflow.edges.find((edge) => edge.source === "start");
    const target = workflow.nodes.find((node) => node.id === fromStart?.target);
    expect(target?.name).toBe("Implement");
  });

  it("gives every block a position, so nothing lands on top of anything else", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const seen = new Set(workflow.nodes.map((node) => JSON.stringify(node.position)));
    expect(seen.size).toBe(workflow.nodes.length);
  });

  it("carries the brief across", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(workflow.brief).toEqual({ goal: "The feature works.", doneCriteria: ["Tests pass."] });
  });

  it("does not share structure with the draft, so editing the workflow cannot alter it", () => {
    const source = draft();
    const { workflow } = mapDraftToWorkflow(source, OPTIONS);
    workflow.brief?.doneCriteria?.push("Something else.");
    expect(source.brief.doneCriteria).toEqual(["Tests pass."]);
  });

  it("stamps the current workflow format, so it opens like any other workflow", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const bag = (workflow.metadata as Record<string, Record<string, unknown>>).workflow;
    expect(bag.formatVersion).toBe(WORKFLOW_FORMAT_VERSION);
  });
});

describe("mapping agents", () => {
  it("mints real profile ids rather than using the draft's", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    // The interpreter said "dev" and "qa"; identity is Anthill's to assign.
    expect(agentProfiles(workflow).map((profile) => profile.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  it("keeps the name, model, role and description it proposed", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(agentProfiles(workflow)[0]).toEqual({
      id: "agent-1",
      name: "Developer",
      models: { "claude-code": { id: "opus" } },
      role: "Builds it",
    });
    expect(agentProfiles(workflow)[1].description).toBe("Runs the suite honestly.");
  });

  it("points two steps at one profile when the draft shares an agent", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(stepsUsingAgent(workflow, "agent-1").map((node) => node.name)).toEqual([
      "Implement",
      "Fix failures",
    ]);
    expect(assignedAgents(workflow)).toHaveLength(2);
  });

  it("writes one agent file per profile, not per step", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(compile(workflow).files.map((file) => file.path)).toEqual([
      ".claude/agents/developer.md",
      ".claude/agents/tester.md",
    ]);
  });

  it("drops a model the harness does not have and says so", () => {
    const source = draft();
    source.agents[0].model = "gpt-9";
    const { workflow, warnings } = mapDraftToWorkflow(source, OPTIONS);
    expect(agentProfiles(workflow)[0]).not.toHaveProperty("model");
    expect(warnings[0].message).toContain("no model called \"gpt-9\"");
  });

  it("leaves a step unassigned when it names an agent the draft did not list", () => {
    const source = draft();
    source.steps[0].agent = "ghost";
    const { workflow, warnings } = mapDraftToWorkflow(source, OPTIONS);
    expect(agentConfig(workflow.nodes[1]).agentId).toBeUndefined();
    expect(warnings.some((item) => item.message.includes("was not in the draft's agent list"))).toBe(true);
    // The gap is then an ordinary Workflow problem the author can act on.
    expect(validateWorkflow(workflow).errors.some((error) => error.code === "STEP_MISSING_AGENT")).toBe(true);
  });
});

describe("mapping connections", () => {
  it("keeps the label, kind and condition of each output", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const rework = workflow.edges.find((edge) => edge.kind === "rework");
    expect(rework).toMatchObject({
      label: "failed",
      condition: 'tester.decision == "failed"',
    });
  });

  it("routes an output to the End block", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(workflow.edges.some((edge) => edge.target === "end")).toBe(true);
  });

  it("builds the loop the draft described", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const verify = workflow.nodes.find((node) => node.name === "Run tests")!;
    const fix = workflow.nodes.find((node) => node.name === "Fix failures")!;
    expect(workflow.edges.some((e) => e.source === fix.id && e.target === verify.id)).toBe(true);
  });

  it("leaves an output pointing at a step that does not exist unconnected", () => {
    const source = draft();
    source.steps[0].outputs = [{ to: "nowhere", label: "onward" }];
    const { workflow, warnings } = mapDraftToWorkflow(source, OPTIONS);

    // Kept as an output rather than dropped: the author can see what the
    // interpreter meant to connect, and where it thought it went.
    const outputs = outputsOf(workflow, workflow.nodes[1].id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ label: "onward", target: null });
    expect(warnings.some((item) => item.message.includes('points at "nowhere"'))).toBe(true);
  });

  it("drops an output pointing at its own step", () => {
    const source = draft();
    source.steps[0].outputs = [{ to: "implement" }, { to: "verify" }];
    const { workflow, warnings } = mapDraftToWorkflow(source, OPTIONS);
    const first = workflow.nodes[1].id;
    expect(workflow.edges.filter((edge) => edge.source === first)).toHaveLength(1);
    expect(warnings.some((item) => item.message.includes("back at itself"))).toBe(true);
  });

  it("warns about a step nothing follows", () => {
    const source = draft();
    delete source.steps[2].outputs;
    const { warnings } = mapDraftToWorkflow(source, OPTIONS);
    expect(warnings.some((item) => item.message.includes("Nothing follows it"))).toBe(true);
  });

  it("gives every output a distinct id", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const ids = workflow.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("approval gates", () => {
  const withGate = () =>
    draft({
      steps: [
        {
          id: "gate",
          name: "Approve the direction",
          kind: "approval",
          question: "Is this the right approach?",
          outputs: [
            { to: "build", kind: "next", label: "approved" },
            { to: "end", kind: "stop", label: "rejected" },
          ],
        },
        {
          id: "build",
          name: "Build",
          kind: "step",
          agent: "dev",
          action: "agent-step",
          task: "Build it.",
          outputs: [{ to: "end" }],
        },
      ],
      agents: [{ id: "dev", name: "Developer" }],
    });

  it("becomes an approval block carrying its question", () => {
    const { workflow } = mapDraftToWorkflow(withGate(), OPTIONS);
    const gate = workflow.nodes.find((node) => node.type === "approval");
    expect(gate?.config).toEqual({ prompt: "Is this the right approach?" });
  });

  it("keeps its labelled paths, which validation requires", () => {
    const { workflow } = mapDraftToWorkflow(withGate(), OPTIONS);
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });
});

describe("traceability", () => {
  it("keeps the author's prompt whole", () => {
    const long = "Build me a thing.\n\nSTAGE 1 — research\n…".repeat(20);
    const { workflow } = mapDraftToWorkflow(draft(), { ...OPTIONS, prompt: long });
    expect(workflowSource(workflow)?.prompt).toBe(long);
  });

  it("records which interpreter drafted it and what was run", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(workflowSource(workflow)).toMatchObject({
      interpreter: "claude-code",
      command: "claude -p --tools ''",
      draftedAt: "2026-08-28T12:00:00.000Z",
    });
  });

  it("keeps the open questions with the workflow, not only in the preview", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(workflowSource(workflow)?.questions.map((item) => item.question)).toEqual([
      "Which test command should be used?",
    ]);
  });

  it("survives a save and a reload as JSON", () => {
    const { workflow } = mapDraftToWorkflow(draft(), OPTIONS);
    const reopened = JSON.parse(JSON.stringify(workflow));
    expect(workflowSource(reopened)?.prompt).toBe(OPTIONS.prompt);
  });

  it("reports no source for a workflow that was not drafted from one", () => {
    expect(workflowSource({ id: "w", name: "n", version: "1", nodes: [], edges: [] })).toBeUndefined();
  });
});

describe("reviewDraft", () => {
  it("gathers the workflow, its agents, the warnings and the validation", () => {
    const review = reviewDraft(draft(), [{ where: "steps[0]", message: "earlier" }], OPTIONS);
    expect(review.validation.valid).toBe(true);
    expect(review.agents.map((profile) => profile.name)).toEqual(["Developer", "Tester"]);
    expect(review.warnings[0].message).toBe("earlier");
  });

  it("surfaces the problems of a draft that maps to an invalid workflow", () => {
    const source = draft();
    source.steps[0].task = undefined;
    const review = reviewDraft(source, [], OPTIONS);
    expect(review.validation.valid).toBe(false);
    expect(review.validation.errors.some((error) => error.code === "STEP_MISSING_TASK")).toBe(true);
  });
});

describe("conditions naming an agent", () => {
  /** What the corpus showed interpreters actually write. */
  const branching = (condition: string): WorkflowDraft => ({
    ...draft(),
    agents: [
      { id: "dev", name: "Developer" },
      { id: "qa", name: "QA Agent" },
    ],
    steps: [
      {
        id: "build",
        name: "Build",
        kind: "step",
        agent: "dev",
        action: "agent-step",
        task: "Build it.",
        maxIterations: 3,
        outputs: [{ to: "check", kind: "next" }],
      },
      {
        id: "check",
        name: "Check",
        kind: "step",
        agent: "qa",
        action: "run-tests",
        task: "Check it.",
        maxIterations: 3,
        outputs: [
          { to: "build", kind: "rework", label: "failed", condition },
          { to: "end", kind: "next", label: "passed" },
        ],
      },
    ],
  });

  it("rewrites a condition written against the draft's agent id", () => {
    const { workflow } = mapDraftToWorkflow(branching('qa.decision == "failed"'), OPTIONS);
    // "qa" is the draft's id for an agent the Workflow calls "qa-agent".
    expect(workflow.edges.find((edge) => edge.kind === "rework")?.condition).toBe(
      'qa-agent.decision == "failed"',
    );
  });

  it("makes the rewritten branch validate, which is the point of doing it", () => {
    const { workflow } = mapDraftToWorkflow(branching('qa.decision == "failed"'), OPTIONS);
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it("says it rewrote it rather than changing the workflow quietly", () => {
    const { warnings } = mapDraftToWorkflow(branching('qa.decision == "failed"'), OPTIONS);
    expect(warnings.some((item) => item.message.includes("rewritten to"))).toBe(true);
  });

  it("leaves a condition that already names the agent correctly alone", () => {
    const { workflow, warnings } = mapDraftToWorkflow(
      branching('qa-agent.decision == "failed"'),
      OPTIONS,
    );
    expect(workflow.edges.find((edge) => edge.kind === "rework")?.condition).toBe(
      'qa-agent.decision == "failed"',
    );
    expect(warnings.some((item) => item.message.includes("rewritten"))).toBe(false);
  });

  it("leaves a condition naming nothing alone, so validation can report it", () => {
    // Inventing a target would hide a real problem behind a guess.
    const { workflow } = mapDraftToWorkflow(branching('someone.decision == "failed"'), OPTIONS);
    expect(workflow.edges.find((edge) => edge.kind === "rework")?.condition).toBe(
      'someone.decision == "failed"',
    );
    expect(
      validateWorkflow(workflow).errors.some((error) => error.code === "CONDITION_UNKNOWN_AGENT"),
    ).toBe(true);
  });

  it("leaves a condition that is not in the grammar alone", () => {
    const { workflow } = mapDraftToWorkflow(branching("tests are green"), OPTIONS);
    expect(workflow.edges.find((edge) => edge.kind === "rework")?.condition).toBe(
      "tests are green",
    );
  });
});

describe("a step that points at itself", () => {
  const repeating = (): WorkflowDraft => ({
    ...draft(),
    steps: [
      {
        id: "ask",
        name: "Ask a question",
        kind: "step",
        agent: "dev",
        action: "agent-step",
        task: "Ask.",
        outputs: [
          { to: "ask", kind: "next", label: "again" },
          { to: "end", kind: "next", label: "done" },
        ],
      },
    ],
  });

  it("drops the self-edge, which the canvas would not let anyone draw either", () => {
    const { workflow } = mapDraftToWorkflow(repeating(), OPTIONS);
    expect(workflow.edges.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it("says what shape to use instead of just dropping it", () => {
    const { warnings } = mapDraftToWorkflow(repeating(), OPTIONS);
    expect(warnings.some((item) => item.message.includes("path back from a later step"))).toBe(
      true,
    );
  });
});

describe("a step with no action", () => {
  const actionless = (): WorkflowDraft => {
    const source = draft();
    delete source.steps[0].action;
    return source;
  };

  it("becomes the general-purpose step rather than an unusable one", () => {
    const { workflow } = mapDraftToWorkflow(actionless(), OPTIONS);
    expect(agentConfig(workflow.nodes[1]).actionKind).toBe("agent-step");
  });

  it("says it chose, rather than leaving the author to discover it", () => {
    const { warnings } = mapDraftToWorkflow(actionless(), OPTIONS);
    expect(warnings.some((item) => item.message.includes("set to Agent Step"))).toBe(true);
  });

  it("leaves a workflow that validates, which is the point of defaulting at all", () => {
    const { workflow } = mapDraftToWorkflow(actionless(), OPTIONS);
    expect(
      validateWorkflow(workflow).errors.some((error) => error.code === "STEP_MISSING_ACTION"),
    ).toBe(false);
  });

  it("does not touch a step that chose one", () => {
    const { workflow, warnings } = mapDraftToWorkflow(draft(), OPTIONS);
    expect(agentConfig(workflow.nodes[2]).actionKind).toBe("run-tests");
    expect(warnings.some((item) => item.message.includes("set to Agent Step"))).toBe(false);
  });
});
