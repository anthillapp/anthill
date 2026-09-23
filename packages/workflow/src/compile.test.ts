import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { WorkflowCompileError, compile } from "./compile.js";

/** Developer -> Reviewer with a "changes requested" loop back, the MVP example. */
function reviewLoop(target: Workflow["target"] = "claude-code"): Workflow {
  return {
    id: "review-loop",
    name: "Review loop",
    description: "Implement a change, then review it until it is approved.",
    version: "1",
    target,
    brief: {
      goal: "Land the change with a passing review.",
      verification: "Run the test suite and read the diff.",
      doneCriteria: ["The reviewer approves.", "The test suite passes."],
    },
    metadata: {
      workflow: {
        agents: [
          { id: "agent-dev", name: "Developer", model: "sonnet" },
          {
            id: "agent-rev",
            name: "Reviewer",
            role: "Reads the diff as a careful reader would",
            model: "opus",
          },
        ],
      },
    },
    nodes: [
      { id: "s", type: "start", name: "Start", config: {} },
      {
        id: "dev",
        type: "agent",
        name: "Implement",
        config: {
          actionKind: "agent-step",
          agentId: "agent-dev",
          purpose: "Implements the requested change",
          task: "Implement the change described by the user.\nKeep the diff minimal.",
          maxIterations: 3,
        },
      },
      {
        id: "rev",
        type: "agent",
        name: "Review",
        config: {
          actionKind: "llm-review",
          agentId: "agent-rev",
          purpose: "Reviews the change",
          task: 'Review the working tree. Reply with decision "approved" or "changes_requested".',
          maxIterations: 3,
        },
      },
      { id: "e", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "s", target: "dev" },
      { id: "e2", source: "dev", target: "rev" },
      {
        id: "e3",
        source: "rev",
        target: "dev",
        condition: 'reviewer.decision == "changes_requested"',
        label: "changes requested",
      },
      { id: "e4", source: "rev", target: "e", label: "approved" },
    ],
  };
}

/**
 * Implement, review, verify, and back round — drawn out of the order it runs.
 *
 * The blocks are declared implement, verify, review while the work goes
 * implement, review, verify, which is the case a two-block loop cannot tell
 * apart: with two members every order is the loop's order.
 */
function verifyLoop(): Workflow {
  const workflow = reviewLoop();
  const agents = (workflow.metadata!.workflow as { agents: Record<string, unknown>[] }).agents;
  agents.push({ id: "agent-qa", name: "Verifier", model: "sonnet" });
  workflow.nodes.splice(2, 0, {
    id: "qa",
    type: "agent",
    name: "Verify",
    config: {
      actionKind: "run-tests",
      agentId: "agent-qa",
      purpose: "Checks the change against the done criteria",
      task: "Run the suite and say whether the done criteria are met.",
      maxIterations: 3,
    },
  });
  workflow.edges = [
    { id: "e1", source: "s", target: "dev" },
    { id: "e2", source: "dev", target: "rev" },
    { id: "e3", source: "rev", target: "qa" },
    {
      id: "e4",
      source: "qa",
      target: "dev",
      condition: 'verifier.decision == "changes_requested"',
      label: "changes requested",
    },
    { id: "e5", source: "qa", target: "e", label: "approved" },
  ];
  return workflow;
}

describe("compile — agent files", () => {
  it("writes one file per role for Claude Code", () => {
    const { files } = compile(reviewLoop());
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/developer.md",
      ".claude/agents/reviewer.md",
    ]);
  });

  it("puts the role's name, purpose, model and task into the file", () => {
    const { files } = compile(reviewLoop());
    const reviewer = files.find((f) => f.path.endsWith("reviewer.md"));

    expect(reviewer?.content).toContain("name: reviewer");
    // No description was written for the Reviewer, so the file gets one
    // assembled from its role and its step — not the step's purpose alone.
    expect(reviewer?.content).toContain(
      'description: "Reviewer: Reads the diff as a careful reader would.',
    );
    expect(reviewer?.content).toContain("reviews the change");
    expect(reviewer?.content).toContain("model: opus");
    expect(reviewer?.content).toContain("Review the working tree.");
  });

  /*
   * ANT-126. The description used to be the first step's purpose, or "The X in
   * this workflow." An agent doing several steps was described by one of them.
   */
  describe("the description when the author wrote none", () => {
    it("is the author's own whenever there is one, untouched", () => {
      const workflow = reviewLoop();
      const agents = (workflow.metadata as { workflow: { agents: { description?: string }[] } })
        .workflow.agents;
      agents[1].description = "Reads every diff twice: once for what it does, once for what it breaks.";
      const reviewer = compile(workflow).files.find((f) => f.path.endsWith("reviewer.md"));
      expect(reviewer?.content).toContain(
        'description: "Reads every diff twice: once for what it does, once for what it breaks."',
      );
      expect(reviewer?.content).not.toContain("It carries out");
    });

    it("covers every step an agent owns, not the first alone", () => {
      const workflow = verifyLoop();
      // Give the Developer the verify step too: two steps, one agent.
      (workflow.nodes[2].config as Record<string, unknown>).agentId = "agent-dev";
      const developer = compile(workflow).files.find((f) => f.path.endsWith("developer.md"));
      const description = developer?.content.split("\n").find((line) => line.startsWith("description:"));
      expect(description).toContain("It carries out 2 steps, in this order:");
      expect(description).toContain("Implement");
      expect(description).toContain("Verify");
      expect(description).toContain("checks the change against the done criteria");
      expect(description).not.toContain("The Developer in this workflow.");
    });

    it("names the work's goal and the step's success criteria", () => {
      const workflow = reviewLoop();
      workflow.nodes[2].config.successCriteria = ["Every comment is actionable."];
      const reviewer = compile(workflow).files.find((f) => f.path.endsWith("reviewer.md"));
      const description = reviewer?.content.split("\n").find((line) => line.startsWith("description:"));
      expect(description).toContain("land the change with a passing review");
      expect(description).toContain("done when: Every comment is actionable.");
    });

    it("gives each of two agents its own, from its own steps", () => {
      const { files } = compile(reviewLoop());
      const developer = files.find((f) => f.path.endsWith("developer.md"));
      const reviewer = files.find((f) => f.path.endsWith("reviewer.md"));
      expect(developer?.content).toContain("description: \"Developer.");
      expect(developer?.content).toContain("implements the requested change");
      expect(developer?.content).not.toContain("reviews the change");
      expect(reviewer?.content).not.toContain("implements the requested change");
    });
  });

  it("falls back to the harness default model when a block does not choose one", () => {
    const workflow = reviewLoop();
    delete (workflow.nodes[1].config as Record<string, unknown>).model;
    const reviewer = compile(workflow).files.find((f) => f.path.endsWith("developer.md"));
    expect(reviewer?.content).toContain("model: sonnet");
  });

  it("quotes descriptions so YAML stays valid", () => {
    const workflow = reviewLoop();
    workflow.nodes[2].config.purpose = 'Checks: "quality", # thoroughly';
    const reviewer = compile(workflow).files.find((f) => f.path.endsWith("reviewer.md"));
    const description = reviewer?.content.split("\n").find((line) => line.startsWith("description:"));
    expect(description).toContain('checks: \\"quality\\", # thoroughly');
    // One quoted scalar, with nothing unescaped inside it.
    expect(description?.slice("description: ".length)).toMatch(/^"(?:[^"\\]|\\.)*"$/);
  });

  /*
   * Codex reads project-scoped custom agents from `.codex/agents/*.toml`, so a
   * Codex workflow gets real agent files like a Claude one. Anthill used to
   * inline every step into one prompt and call that a Codex limitation; it was
   * an Anthill limitation.
   */
  it("writes a TOML agent file per role for Codex", () => {
    const { files } = compile(reviewLoop("codex"));
    expect(files.map((f) => f.path)).toEqual([
      ".codex/agents/developer.toml",
      ".codex/agents/reviewer.toml",
    ]);
  });

  it("writes the keys Codex documents, and no others", () => {
    const workflow = reviewLoop("codex");
    const agents = (workflow.metadata as { workflow: { agents: { models?: unknown }[] } }).workflow
      .agents;
    agents[1].models = { codex: { id: "gpt-5.6-sol", reasoningEffort: "high" } };

    const reviewer = compile(workflow).files.find((f) => f.path.endsWith("reviewer.toml"));
    expect(reviewer?.content).toContain('name = "reviewer"');
    expect(reviewer?.content).toContain('description = "Reviewer: Reads the diff as a careful reader would.');
    expect(reviewer?.content).toContain("developer_instructions = \"\"\"");
    expect(reviewer?.content).toContain('model = "gpt-5.6-sol"');
    expect(reviewer?.content).toContain('model_reasoning_effort = "high"');
  });

  /*
   * A Codex agent file with no `model` inherits the spawning session's. Writing
   * a resolved name instead would turn a deliberate inherit into a pin — and
   * pin it to whatever Anthill believed the default was that day.
   */
  it("omits the model for an agent told to inherit, and for one nobody answered", () => {
    const workflow = reviewLoop("codex");
    const agents = (workflow.metadata as { workflow: { agents: { models?: unknown }[] } }).workflow
      .agents;
    agents[0].models = { codex: { id: "__default__" } };

    const files = compile(workflow).files;
    const developer = files.find((f) => f.path.endsWith("developer.toml"));
    const reviewer = files.find((f) => f.path.endsWith("reviewer.toml"));
    expect(developer?.content).not.toContain("model =");
    expect(reviewer?.content).not.toContain("model =");
  });

  it("never carries a Claude answer into a Codex file", () => {
    // The agents in this fixture are answered for Claude Code only.
    const codex = compile(reviewLoop("codex")).files;
    expect(codex.map((f) => f.content).join(" ")).not.toContain("opus");
  });

  it("renders purpose, inputs, success criteria and handoff for a single-step agent", () => {
    // The main prompt always rendered all eight step fields; the agent file
    // used to render only the task, dropping the rest for an agent doing one
    // stage. This is the single-step branch of `buildAgentFile`.
    const workflow = reviewLoop();
    Object.assign(workflow.nodes[2].config, {
      inputs: ["The diff", "The acceptance criteria"],
      successCriteria: ["Every issue names a file and says what is wrong."],
      handoff: "Send the decision back to the developer.",
    });
    const reviewer = compile(workflow).files.find((f) => f.path.endsWith("reviewer.md"));

    expect(reviewer?.content).toContain("Purpose: Reviews the change");
    expect(reviewer?.content).toContain("Inputs:");
    expect(reviewer?.content).toContain("- The diff");
    expect(reviewer?.content).toContain("- The acceptance criteria");
    expect(reviewer?.content).toContain("This step succeeds when:");
    expect(reviewer?.content).toContain("- Every issue names a file and says what is wrong.");
    expect(reviewer?.content).toContain("Hand off: Send the decision back to the developer.");
  });

  it("renders purpose, inputs, success criteria and handoff per stage for a multi-step agent", () => {
    // Same fields, the branch of `buildAgentFile` that lists several stages
    // under one agent (`assignment.stepIds.length > 1`).
    const workflow = reviewLoop();
    // One agent, two stages — the same reassignment the prompt-side "covers
    // more than one" test above uses.
    (workflow.nodes[2].config as Record<string, unknown>).agentId = "agent-dev";
    Object.assign(workflow.nodes[1].config, {
      inputs: ["The user's request"],
      successCriteria: ["The diff builds."],
      handoff: "Hand the diff to the reviewer.",
    });
    Object.assign(workflow.nodes[2].config, {
      inputs: ["The diff"],
      successCriteria: ["No unresolved comments remain."],
      handoff: "Report the decision.",
    });

    const developer = compile(workflow).files.find((f) => f.path.endsWith("developer.md"));
    const content = developer?.content ?? "";

    expect(content).toContain("## Implement");
    expect(content).toContain("Purpose: Implements the requested change");
    expect(content).toContain("- The user's request");
    expect(content).toContain("This step succeeds when:");
    expect(content).toContain("- The diff builds.");
    expect(content).toContain("Hand off: Hand the diff to the reviewer.");

    expect(content).toContain("## Review");
    expect(content).toContain("Purpose: Reviews the change");
    expect(content).toContain("- The diff");
    expect(content).toContain("- No unresolved comments remain.");
    expect(content).toContain("Hand off: Report the decision.");
  });
});

describe("compile — prompt", () => {
  it("numbers steps by their own name, skipping start and end", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("### 1. Implement — delegate to the `developer` subagent");
    expect(prompt).toContain("### 2. Review — delegate to the `reviewer` subagent");
    expect(prompt).not.toContain("### 3.");
  });

  it("tells the agent to delegate to the subagent by name", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("delegate to the `developer` subagent");
    expect(prompt).toContain("delegate to the `reviewer` subagent");
  });

  it("lists the agents with their roles and models", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("## Agents");
    expect(prompt).toContain("`developer` (Developer) — model: sonnet");
    expect(prompt).toContain(
      "`reviewer` (Reviewer) — Reads the diff as a careful reader would — model: opus",
    );
  });

  it("says how many steps an agent covers when it covers more than one", () => {
    const workflow = reviewLoop();
    // Point the review step at the developer too: one agent, two steps.
    (workflow.nodes[2].config as Record<string, unknown>).agentId = "agent-dev";
    const { prompt } = compile(workflow);
    expect(prompt).toContain("`developer` (Developer) — 2 steps");
  });

  it("names the action each step performs", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("Action: Agent Step");
    expect(prompt).toContain("Action: LLM Review");
  });

  it("renders an unconditional transition as a single line", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("Then continue to step 2 (Review).");
  });

  it("renders conditions in readable form with their label", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain(
      '- if `reviewer.decision` is "changes_requested" (changes requested), go back to step 1 (Implement), at most 3 passes in total.',
    );
  });

  it("renders the end block as a stop rather than a step", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("stop — the workflow is complete (Done)");
  });

  it("includes the workflow name and description", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("# Review loop");
    expect(prompt).toContain("Implement a change, then review it until it is approved.");
  });

  it("says that hitting the pass limit is a result to report, not a finish", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain(
      "Stop after at most 3 passes. Reaching that limit is a result to report, not a reason to declare the work finished.",
    );
  });

  /* Codex has custom agents, so its prompt delegates to them by name rather
     than asking one session to play every part in turn. */
  it("delegates to the named agents for Codex, as it does for Claude Code", () => {
    const { prompt } = compile(reviewLoop("codex"));
    expect(prompt).toContain(".codex/agents/");
    expect(prompt).toContain("delegate to the `developer` subagent");
  });
});

describe("compile — outcome kinds", () => {
  it("says work is being sent back, not merely routed, for a rework output", () => {
    const workflow = reviewLoop();
    const loopBack = workflow.edges.find((edge) => edge.id === "e3")!;
    loopBack.kind = "rework";
    const { prompt } = compile(workflow);
    expect(prompt).toContain("send the work back to step 1 (Implement) to be redone");
    expect(prompt).toContain("at most 3 passes in total");
  });

  it("says a question output waits for an answer", () => {
    const workflow = reviewLoop();
    workflow.edges.find((edge) => edge.id === "e3")!.kind = "question";
    expect(compile(workflow).prompt).toContain(
      "put the question to step 1 (Implement) and wait for the answer",
    );
  });

  it("treats an output with no kind as `next`, as before", () => {
    const workflow = reviewLoop();
    delete workflow.edges.find((edge) => edge.id === "e2")!.kind;
    expect(compile(workflow).prompt).toContain("Then continue to step 2 (Review).");
  });
});

describe("compile — honesty", () => {
  it("says in the output that Anthill does not run the workflow", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("Anthill does");
    expect(prompt).toContain("not run it");
    expect(prompt).toContain("not behaviour Anthill enforces");
  });

  it("puts the warning before anything it qualifies", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt.indexOf("How to read this workflow")).toBeLessThan(
      prompt.indexOf("## Shared context"),
    );
  });

  it("warns even for a workflow with no branches or loops", () => {
    const workflow = reviewLoop();
    workflow.edges = workflow.edges.filter((edge) => edge.id !== "e3");
    workflow.brief = { ...workflow.brief, doneCriteria: ["It works."] };
    expect(compile(workflow).prompt).toContain("How to read this workflow");
  });
});

describe("compile — brief", () => {
  it("gathers everything workflow-wide into one shared-context block", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("## Shared context");
    expect(prompt).toContain("This section applies to every step below.");
    expect(prompt).toContain("### Goal\n\nLand the change with a passing review.");
    expect(prompt).toContain("### Verification\n\nRun the test suite and read the diff.");
    expect(prompt).toContain(
      "### Done criteria\n\n- The reviewer approves.\n- The test suite passes.",
    );
  });

  it("puts the shared context before the steps", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt.indexOf("## Shared context")).toBeLessThan(prompt.indexOf("## Steps"));
  });

  it("renders project context, assumptions and prohibitions when given", () => {
    const workflow = reviewLoop();
    workflow.brief = {
      ...workflow.brief,
      context: "A TypeScript monorepo.",
      assumptions: ["The suite is green today."],
      prohibitedActions: ["Do not touch the database schema."],
    };
    const { prompt } = compile(workflow);
    expect(prompt).toContain("### Project context\n\nA TypeScript monorepo.");
    expect(prompt).toContain("### Assumptions\n\n- The suite is green today.");
    expect(prompt).toContain("### Do not\n\n- Do not touch the database schema.");
  });

  it("omits shared-context headings that have nothing to say", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).not.toContain("### Project context");
    expect(prompt).not.toContain("### Assumptions");
    expect(prompt).not.toContain("### Do not");
  });

  it("renders the final action as its own section when given", () => {
    const workflow = reviewLoop();
    workflow.brief = { ...workflow.brief, finalAction: "Open a pull request." };
    const { prompt } = compile(workflow);
    expect(prompt).toContain("## Final action\n\nOpen a pull request.");
    expect(prompt.indexOf("## Final action")).toBeLessThan(
      prompt.indexOf("## Report at the end"),
    );
  });

  it("puts the default constraints in the shared context, not among the mechanical rules", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain(
      "### Constraints\n\n- Stay on this task. Do not switch to unrelated work.",
    );
    expect(prompt).toContain("Do not make a check pass without fixing the underlying issue.");
    // Constraints buried at the bottom get read last, if at all.
    expect(prompt.indexOf("### Constraints")).toBeLessThan(prompt.indexOf("## Steps"));
  });

  it("reminds the reader that constraints outlive the current step", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain(
      "The constraints in the shared context apply throughout, not only to the step being worked on.",
    );
  });

  it("lets a workflow replace the constraints", () => {
    const workflow = reviewLoop();
    workflow.brief = { ...workflow.brief, constraints: ["Only touch the parser."] };
    const { prompt } = compile(workflow);
    expect(prompt).toContain("- Only touch the parser.");
    expect(prompt).not.toContain("Do not make a check pass");
  });

  it("asks for the default report sections at the end", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("## Report at the end");
    expect(prompt).toContain("- Root cause");
    expect(prompt).toContain("- Remaining risks");
  });
});

describe("compile — loops", () => {
  it("describes the feedback loop as a cycle of work", () => {
    const { prompt } = compile(reviewLoop());
    expect(prompt).toContain("## Loops");
    // Step name and role name are easy to confuse, so the heading names both.
    expect(prompt).toContain("### Implement (Developer) ⇄ Review (Reviewer)");
    expect(prompt).toContain("Investigate what is actually wrong before changing anything.");
    expect(prompt).toContain("Make the smallest reasonable fix.");
    expect(prompt).toContain("Verify it independently");
    expect(prompt).toContain("Evaluate against the done criteria above.");
  });

  it("names a loop's steps in the order the work goes round them", () => {
    const { prompt } = compile(verifyLoop());

    // The blocks are drawn implement, verify, review. A heading in that order
    // describes a loop nobody built.
    expect(prompt).toContain(
      "### Implement (Developer) ⇄ Review (Reviewer) ⇄ Verify (Verifier)",
    );
  });

  it("omits the loop section entirely for a linear diagram", () => {
    const workflow = reviewLoop();
    workflow.edges = workflow.edges.filter((edge) => edge.id !== "e3");
    const { prompt } = compile(workflow);
    expect(prompt).not.toContain("## Loops");
  });

  it("refuses to compile a looping diagram that has no done criteria", () => {
    const workflow = reviewLoop();
    workflow.brief = { goal: "Ship it." };
    expect(() => compile(workflow)).toThrow(WorkflowCompileError);
    try {
      compile(workflow);
    } catch (error) {
      expect((error as WorkflowCompileError).issues.join(" ")).toContain("done criteria");
    }
  });

  it("allows a linear diagram with no done criteria", () => {
    const workflow = reviewLoop();
    workflow.edges = workflow.edges.filter((edge) => edge.id !== "e3");
    workflow.brief = { goal: "Ship it." };
    expect(() => compile(workflow)).not.toThrow();
  });
});

describe("compile — refusal", () => {
  it("throws rather than producing a prompt from an invalid diagram", () => {
    const workflow = reviewLoop();
    workflow.nodes[1].config.task = "";
    expect(() => compile(workflow)).toThrow(WorkflowCompileError);
  });

  it("reports every reason it refused", () => {
    const broken: Workflow = {
      id: "x",
      name: "Broken",
      version: "1",
      nodes: [],
      edges: [],
    };
    try {
      compile(broken);
      expect.unreachable("compile should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowCompileError);
      expect((error as WorkflowCompileError).issues.length).toBeGreaterThan(1);
    }
  });
});
