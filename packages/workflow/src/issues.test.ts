import { describe, expect, it } from "vitest";
import type { ValidationResult, Workflow } from "@anthill/workflow-schema";

import { allIssues, issuesForEdge, issuesForNode, workflowLevelIssues } from "./issues.js";
import { WORKFLOWNER_ADVISORY_CODES, WORKFLOWNER_VALIDATION_CODES, validateWorkflow } from "./workflow.js";

const result = (
  errors: ValidationResult["errors"],
  warnings: ValidationResult["errors"] = [],
): ValidationResult => ({ valid: errors.length === 0, errors, warnings });

describe("severity", () => {
  it("separates what blocks a workflow from what merely weakens it", () => {
    const issues = allIssues(
      result(
        [{ code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK, message: "x", nodeId: "a" }],
        [{ code: WORKFLOWNER_ADVISORY_CODES.STEP_NO_EXPECTED_OUTPUT, message: "y", nodeId: "a" }],
      ),
    );
    expect(issues.map((issue) => issue.severity)).toEqual(["error", "advisory"]);
  });

  it("puts errors first, since they are what stops the workflow", () => {
    const issues = allIssues(
      result(
        [{ code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION, message: "x", nodeId: "a" }],
        [{ code: WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL, message: "y" }],
      ),
    );
    expect(issues[0].severity).toBe("error");
  });

  it("copes with a result from before advisories existed", () => {
    expect(allIssues({ valid: true, errors: [] })).toEqual([]);
  });
});

describe("issuesForNode", () => {
  const validation = result(
    [
      { code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK, message: "task", nodeId: "a" },
      { code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION, message: "action", nodeId: "a" },
      { code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK, message: "other", nodeId: "b" },
      { code: WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION, message: "edge", edgeId: "e1" },
      { code: WORKFLOWNER_VALIDATION_CODES.NO_END_BLOCK, message: "workflow" },
    ],
    [{ code: WORKFLOWNER_ADVISORY_CODES.STEP_NO_SUCCESS_CRITERIA, message: "criteria", nodeId: "a" }],
  );

  it("returns every issue for that block and no others", () => {
    expect(issuesForNode(validation, "a").map((issue) => issue.message)).toEqual([
      "task",
      "action",
      "criteria",
    ]);
  });

  it("leaves out issues belonging to a connection or to the workflow", () => {
    const messages = issuesForNode(validation, "a").map((issue) => issue.message);
    expect(messages).not.toContain("edge");
    expect(messages).not.toContain("workflow");
  });

  it("returns nothing for a block with nothing wrong", () => {
    expect(issuesForNode(validation, "clean")).toEqual([]);
  });
});

describe("issuesForEdge", () => {
  it("returns only that connection's issues", () => {
    const validation = result([
      { code: WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION, message: "bad", edgeId: "e1" },
      { code: WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION, message: "other", edgeId: "e2" },
    ]);
    expect(issuesForEdge(validation, "e1").map((issue) => issue.message)).toEqual(["bad"]);
  });
});

describe("workflowLevelIssues", () => {
  it("returns what belongs to the workflow rather than to anything in it", () => {
    const validation = result(
      [
        { code: WORKFLOWNER_VALIDATION_CODES.NO_END_BLOCK, message: "no end" },
        { code: WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK, message: "step", nodeId: "a" },
      ],
      [{ code: WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL, message: "no goal" }],
    );
    expect(workflowLevelIssues(validation).map((issue) => issue.message)).toEqual([
      "no end",
      "no goal",
    ]);
  });
});

describe("fixes", () => {
  const fixFor = (code: string, nodeId = "a") =>
    allIssues(result([{ code, message: "m", nodeId }]))[0].fix;

  it("sends a missing action, task or agent to the Task tab", () => {
    for (const code of [
      WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION,
      WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK,
      WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_AGENT,
      WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT,
    ]) {
      expect(fixFor(code)).toMatchObject({ kind: "step-field", tab: "task" });
    }
  });

  it("sends an unbounded loop to the Limits tab, where the pass limit is", () => {
    expect(fixFor(WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP)).toMatchObject({
      kind: "step-field",
      tab: "limits",
    });
  });

  it("reports a missing goal without offering a fix that leads nowhere", () => {
    const issue = allIssues(
      result([], [{ code: WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL, message: "m" }]),
    )[0];
    // The brief has no editing surface, so this issue offers no shortcut — but
    // it still has to be reported, or a workflow with no goal would look finished.
    expect(issue.fix).toBeUndefined();
    expect(issue.message.length).toBeGreaterThan(0);
  });

  it("offers to connect the output that is not connected", () => {
    const issue = issuesForNode(
      result([
        { code: WORKFLOWNER_VALIDATION_CODES.OUTPUT_NOT_CONNECTED, message: "m", nodeId: "a" },
      ]),
      "a",
      { unconnectedOutputId: "out-3" },
    )[0];
    expect(issue.fix).toEqual({ kind: "connect-output", outputId: "out-3", label: "Connect it" });
  });

  it("offers no button when there is no single obvious fix", () => {
    // "Nothing connects to this block" is answered by rethinking the workflow, not
    // by jumping to a field.
    expect(fixFor(WORKFLOWNER_VALIDATION_CODES.UNREACHABLE_BLOCK)).toBeUndefined();
  });
});

/** The same workflow with its agent's model and description questions answered. */
function answered(built: Workflow): Workflow {
  const agents = (
    built.metadata as { workflow: { agents: { models?: unknown; description?: string }[] } }
  ).workflow.agents;
  agents[0].models = { "claude-code": { id: "__default__" } };
  agents[0].description =
    "Reads the request and the code around it, makes the smallest change that does the job, and hands back a diff with the tests that prove it.";
  return built;
}

describe("advisories from a real workflow", () => {
  const workflow = (config: Record<string, unknown>, brief = {}) => ({
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code" as const,
    brief,
    metadata: { workflow: { agents: [{ id: "agent-1", name: "Dev" }] } },
    nodes: [
      { id: "s", type: "start" as const, name: "Start", config: {} },
      { id: "a", type: "agent" as const, name: "Step", config },
      { id: "e", type: "end" as const, name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "s", target: "a" },
      { id: "e2", source: "a", target: "e" },
    ],
  });

  const complete = {
    actionKind: "agent-step",
    agentId: "agent-1",
    task: "Do it.",
    expectedOutput: "A diff.",
    successCriteria: ["It builds."],
  };

  it("does not stop a workflow compiling", () => {
    const validation = validateWorkflow(workflow({ ...complete, expectedOutput: undefined }));
    expect(validation.valid).toBe(true);
    expect(validation.warnings?.length).toBeGreaterThan(0);
  });

  it("says when a step never states what it produces", () => {
    const validation = validateWorkflow(workflow({ ...complete, expectedOutput: undefined }));
    expect(validation.warnings?.map((item) => item.code)).toContain(
      WORKFLOWNER_ADVISORY_CODES.STEP_NO_EXPECTED_OUTPUT,
    );
  });

  it("says when nothing can check that a step worked", () => {
    const validation = validateWorkflow(workflow({ ...complete, successCriteria: undefined }));
    expect(validation.warnings?.map((item) => item.code)).toContain(
      WORKFLOWNER_ADVISORY_CODES.STEP_NO_SUCCESS_CRITERIA,
    );
  });

  it("says when the brief never states a goal", () => {
    expect(validateWorkflow(workflow(complete)).warnings?.map((item) => item.code)).toContain(
      WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL,
    );
  });

  it("goes quiet once the fields are filled in", () => {
    const validation = validateWorkflow(answered(workflow(complete, { goal: "Ship it." })));
    expect(validation.warnings).toEqual([]);
  });

  /*
   * ANT-126. An agent with a name, a one-line role and no description opened
   * its file with nothing about how to work. Said against a step that uses
   * it, like the model advisory, so the fix button has somewhere to go.
   */
  it("says when an agent has no description", () => {
    const built = answered(workflow(complete, { goal: "Ship it." }));
    const agents = (built.metadata as { workflow: { agents: { description?: string }[] } })
      .workflow.agents;
    delete agents[0].description;

    const said = (validateWorkflow(built).warnings ?? []).filter(
      (item) => item.code === WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION,
    );
    expect(said).toHaveLength(1);
    expect(said[0].message).toContain("Dev has no description");
    expect(said[0].nodeId).toBe("a");
  });

  it("says when a description is a title rather than a job", () => {
    const built = answered(workflow(complete, { goal: "Ship it." }));
    const agents = (built.metadata as { workflow: { agents: { description?: string }[] } })
      .workflow.agents;
    agents[0].description = "Handles the dev work.";

    const said = (validateWorkflow(built).warnings ?? []).filter(
      (item) => item.code === WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION,
    );
    expect(said).toHaveLength(1);
    expect(said[0].message).toContain("too short to guide its work");
  });

  it("offers to edit the agent for a missing description", () => {
    const issue = allIssues(
      result([], [{ code: WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION, message: "m", nodeId: "a" }]),
    )[0];
    expect(issue.fix).toEqual({ kind: "edit-agent", label: "Write the description" });
  });

  /*
   * ANT-50. Switching a workflow's target is the one place a per-tool model
   * quietly changes what runs, so that is where it is said — and only there.
   * An agent nobody has chosen for is not missing anything.
   */
  it("says an agent's model belongs to the other tool, when it does", () => {
    const built: Workflow = { ...workflow(complete, { goal: "Ship it." }), target: "codex" };
    const agents = (built.metadata as { workflow: { agents: { models?: unknown }[] } }).workflow
      .agents;
    agents[0].models = { "claude-code": "opus" };

    const said = (validateWorkflow(built).warnings ?? [])
      .filter((item) => item.code === "AGENT_NO_MODEL_FOR_TARGET")
      .map((item) => item.message)
      .join(" ");
    expect(said).toContain("Claude Code");
    expect(said).toContain("OpenAI Codex CLI");
    expect(said).toContain("not carried over");
  });

  /*
   * ANT-51. This used to stay quiet, on the grounds that a warning would sit on
   * almost every workflow — which was true while Codex could not be answered at
   * all. Both tools have a real picker now, so an unanswered one is a gap the
   * author can close, and an explicit "inherit" closes it.
   */
  it("says when the workflow's own tool has no answer", () => {
    const built = workflow(complete, { goal: "Ship it." });
    const said = (validateWorkflow(built).warnings ?? []).filter(
      (item) => item.code === "AGENT_NO_MODEL_FOR_TARGET",
    );
    expect(said).toHaveLength(1);
    expect(said[0].message).toContain("Claude Code");
  });

  it("stays quiet once the author has answered, including with 'inherit'", () => {
    const built = workflow(complete, { goal: "Ship it." });
    const agents = (built.metadata as { workflow: { agents: { models?: unknown }[] } }).workflow
      .agents;
    // A decision, not a gap: raising it would be arguing with the author.
    agents[0].models = { "claude-code": { id: "__default__" } };
    expect(
      validateWorkflow(built).warnings?.filter(
        (item) => item.code === WORKFLOWNER_ADVISORY_CODES.AGENT_NO_MODEL_FOR_TARGET,
      ),
    ).toEqual([]);
  });

  it("says nothing about a step with no action, which has a real error already", () => {
    const validation = validateWorkflow(
      answered(workflow({ agentId: "agent-1", task: "x" }, { goal: "g" })),
    );
    // Piling advisories on top of "choose an action" would bury the one that
    // matters.
    expect(validation.warnings).toEqual([]);
  });
});
