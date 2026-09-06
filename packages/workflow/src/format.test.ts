import { describe, expect, it } from "vitest";
import { parseWorkflow, type Workflow } from "@anthill/workflow-schema";

import { agentProfiles } from "./agents.js";

import {
  WORKFLOW_FORMAT_VERSION,
  checkWorkflowCompatibility,
  migrateWorkflow,
  workflowFormatVersion,
  stampWorkflowFormat,
} from "./format.js";

function workflow(metadata?: Record<string, unknown>): Workflow {
  return { id: "wf", name: "Workflow", version: "1", nodes: [], edges: [], metadata };
}

describe("stampWorkflowFormat", () => {
  it("records the current format version", () => {
    const stamped = stampWorkflowFormat(workflow());
    expect(workflowFormatVersion(stamped)).toBe(WORKFLOW_FORMAT_VERSION);
  });

  it("keeps unrelated metadata", () => {
    const stamped = stampWorkflowFormat(workflow({ canvas: { zoom: 2 } }));
    expect(stamped.metadata?.canvas).toEqual({ zoom: 2 });
  });

  it("does not mutate the workflow it was given", () => {
    const original = workflow();
    stampWorkflowFormat(original);
    expect(original.metadata).toBeUndefined();
  });

  it("stays out of the shared schema's own fields", () => {
    const stamped = stampWorkflowFormat(workflow());
    // The version belongs to the Workflow, not to Workflow itself — the runner
    // shares this type and must not grow a Workflow-only field.
    expect(stamped).not.toHaveProperty("formatVersion");
    expect(stamped.metadata?.workflow).toEqual({ formatVersion: WORKFLOW_FORMAT_VERSION });
  });
});

describe("workflowFormatVersion", () => {
  it("is undefined for a workflow saved before versioning existed", () => {
    expect(workflowFormatVersion(workflow())).toBeUndefined();
  });

  it("ignores a non-integer stamp", () => {
    expect(workflowFormatVersion(workflow({ workflow: { formatVersion: "2" } }))).toBeUndefined();
    expect(workflowFormatVersion(workflow({ workflow: { formatVersion: 1.5 } }))).toBeUndefined();
  });
});

describe("checkWorkflowCompatibility", () => {
  it("accepts a workflow written by this build", () => {
    const result = checkWorkflowCompatibility(stampWorkflowFormat(workflow()));
    expect(result).toEqual({ ok: true, version: WORKFLOW_FORMAT_VERSION });
  });

  it("reports an unversioned workflow as legacy, with a message that says what to do", () => {
    const result = checkWorkflowCompatibility(workflow());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy");
    expect(result.message).toContain("save it again");
  });

  it("refuses a workflow from a newer build and explains why", () => {
    const result = checkWorkflowCompatibility(
      workflow({ workflow: { formatVersion: WORKFLOW_FORMAT_VERSION + 1 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-new");
    expect(result.message).toContain("Update Anthill");
    // Silently dropping what this build cannot represent, then saving over the
    // file, is the failure this guard exists to prevent.
    expect(result.message).toContain("discard");
  });
});

describe("older formats", () => {
  it("reports a version 1 workflow as legacy and says what to do", () => {
    const result = checkWorkflowCompatibility(workflow({ workflow: { formatVersion: 1 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy");
    // Vague "this is old" helps nobody; say what to do about it.
    expect(result.message).toContain("check every block");
  });
});

describe("checking compatibility before schema parsing", () => {
  it("reads the version from raw JSON that is not a valid Workflow", () => {
    // A workflow from a newer build may not satisfy this build's schema at all.
    // The version must still be readable, or the user gets a generic
    // "invalid workflow" error instead of the real reason.
    const raw = JSON.parse(
      JSON.stringify({
        nodes: [{ type: "some-future-node-type" }],
        metadata: { workflow: { formatVersion: 99 } },
      }),
    );
    expect(workflowFormatVersion(raw)).toBe(99);

    const result = checkWorkflowCompatibility(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-new");
  });

  it("survives values that are not workflows at all", () => {
    for (const value of [null, undefined, 42, "workflow", [], { metadata: 7 }]) {
      expect(workflowFormatVersion(value)).toBeUndefined();
      expect(checkWorkflowCompatibility(value).ok).toBe(false);
    }
  });

  it("ignores a workflow namespace that is not an object", () => {
    expect(workflowFormatVersion({ metadata: { workflow: "v2" } })).toBeUndefined();
  });
});

describe("migrating a version 2 workflow to agent profiles", () => {
  /** A workflow as version 2 wrote it: role fields repeated on every step. */
  const version2 = () => ({
    id: "wf",
    name: "Review loop",
    version: "1",
    target: "claude-code",
    metadata: { workflow: { formatVersion: 2 } },
    nodes: [
      { id: "s", type: "start", name: "Start", config: {} },
      {
        id: "a",
        type: "agent",
        name: "Implement",
        config: {
          actionKind: "agent-step",
          roleId: "role-dev",
          roleName: "Developer",
          model: "sonnet",
          task: "Implement it.",
        },
      },
      {
        id: "b",
        type: "agent",
        name: "Fix",
        config: {
          actionKind: "agent-step",
          roleId: "role-dev",
          roleName: "Developer",
          task: "Fix what review found.",
        },
      },
      { id: "e", type: "end", name: "Done", config: {} },
    ],
    edges: [],
  });

  const migrated = () => migrateWorkflow(version2()).workflow as Record<string, any>;

  it("turns the roles repeated across steps into one profile each", () => {
    expect(migrated().metadata.workflow.agents).toEqual([
      { id: "role-dev", name: "Developer", model: "sonnet" },
    ]);
  });

  it("keeps the old role id, so no step reference has to be rewritten", () => {
    expect(migrated().nodes[1].config.agentId).toBe("role-dev");
    expect(migrated().nodes[2].config.agentId).toBe("role-dev");
  });

  it("takes the name and model off the steps, leaving one source of truth", () => {
    const step = migrated().nodes[1].config;
    expect(step).not.toHaveProperty("roleId");
    expect(step).not.toHaveProperty("roleName");
    expect(step).not.toHaveProperty("model");
  });

  it("keeps the rest of a step's config", () => {
    expect(migrated().nodes[1].config).toMatchObject({
      actionKind: "agent-step",
      task: "Implement it.",
    });
  });

  it("takes the model from whichever step named one", () => {
    // The second step left it blank; a blank must not clear what the first set.
    const workflow = version2() as Record<string, any>;
    delete workflow.nodes[1].config.model;
    workflow.nodes[2].config.model = "opus";
    const result = migrateWorkflow(workflow).workflow as Record<string, any>;
    expect(result.metadata.workflow.agents[0].model).toBe("opus");
  });

  it("carries a version 2 workflow all the way to current in one call", () => {
    // Chained, so an old workflow does not have to be opened and saved once per
    // format step.
    expect(checkWorkflowCompatibility(migrated())).toEqual({
      ok: true,
      version: WORKFLOW_FORMAT_VERSION,
    });
  });

  it("says what it did, so the change is not silent", () => {
    expect(migrateWorkflow(version2()).notes[0]).toContain("Agents tab");
  });

  it("leaves a workflow that is already current alone", () => {
    const current = { metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION } } };
    const result = migrateWorkflow(current);
    expect(result.workflow).toBe(current);
    expect(result.notes).toEqual([]);
  });

  it("does not touch a version 1 workflow, which it does not know how to upgrade", () => {
    const old = { metadata: { workflow: { formatVersion: 1 } } };
    expect(migrateWorkflow(old).workflow).toBe(old);
  });

  it("survives a workflow that is not an object at all", () => {
    expect(migrateWorkflow(null).workflow).toBeNull();
  });

  it("produces a workflow the schema still accepts", () => {
    expect(() => parseWorkflow(migrated())).not.toThrow();
  });
});

describe("migrating a version 3 workflow's open questions", () => {
  const version3 = (source?: Record<string, unknown>) => ({
    id: "wf",
    name: "Drafted workflow",
    version: "1",
    target: "claude-code",
    metadata: {
      workflow: {
        formatVersion: 3,
        agents: [{ id: "agent-1", name: "Developer" }],
        ...(source ? { source } : {}),
      },
    },
    nodes: [],
    edges: [],
  });

  const questionsOf = (workflow: unknown) =>
    (migrateWorkflow(workflow).workflow as Record<string, any>).metadata.workflow.source?.questions;

  it("turns the two loose string lists into answerable questions", () => {
    const questions = questionsOf(
      version3({
        kind: "prompt",
        prompt: "p",
        uncertainties: ["The rate is not stated."],
        questions: ["Which repository?"],
      }),
    );
    expect(questions).toEqual([
      { id: "q1", question: "The rate is not stated.", about: { kind: "workflow" }, options: [] },
      { id: "q2", question: "Which repository?", about: { kind: "workflow" }, options: [] },
    ]);
  });

  it("leaves them open, because that is what they were", () => {
    const questions = questionsOf(
      version3({ kind: "prompt", prompt: "p", questions: ["Which repository?"] }),
    );
    expect(questions[0]).not.toHaveProperty("answer");
  });

  it("drops the field that no longer exists", () => {
    const source = (
      migrateWorkflow(version3({ kind: "prompt", prompt: "p", uncertainties: ["x"] }))
        .workflow as Record<string, any>
    ).metadata.workflow.source;
    expect(source).not.toHaveProperty("uncertainties");
  });

  it("says what it did when there was something to carry over", () => {
    const notes = migrateWorkflow(
      version3({ kind: "prompt", prompt: "p", questions: ["Which repository?"] }),
    ).notes;
    expect(notes[0]).toContain("answerable");
  });

  it("says nothing when the workflow had no open questions", () => {
    expect(migrateWorkflow(version3({ kind: "prompt", prompt: "p" })).notes).toEqual([]);
  });

  it("leaves a workflow that was never drafted from a prompt alone", () => {
    const workflow = version3();
    const upgraded = migrateWorkflow(workflow).workflow as Record<string, any>;
    expect(upgraded.metadata.workflow.source).toBeUndefined();
    expect(upgraded.metadata.workflow.agents).toHaveLength(1);
  });

  it("stamps the current format either way", () => {
    expect(checkWorkflowCompatibility(migrateWorkflow(version3()).workflow)).toEqual({
      ok: true,
      version: WORKFLOW_FORMAT_VERSION,
    });
  });

  it("produces a workflow the schema still accepts", () => {
    expect(() => parseWorkflow(migrateWorkflow(version3()).workflow)).not.toThrow();
  });
});

describe("version 4 to 5 — the rename that reached the file", () => {
  /**
   * This is the migration that could have cost someone their work. Every
   * workflow saved before it keeps its agents and its version under
   * `metadata.planner`, and a reader that only knew the new key would have
   * shown an unversioned workflow with no agents rather than failing.
   */
  function saved(nodes: unknown[] = []): Record<string, unknown> {
    return {
      id: "w1",
      name: "Saved before the rename",
      version: "1",
      target: "claude-code",
      nodes,
      edges: [],
      metadata: {
        planner: {
          formatVersion: 4,
          agents: [{ id: "agent-1", name: "Developer" }],
        },
      },
    };
  }

  it("reads the version out of the old key, so the file is not treated as unversioned", () => {
    expect(workflowFormatVersion(saved())).toBe(4);
  });

  it("moves the metadata across and leaves no second copy behind", () => {
    const { workflow } = migrateWorkflow(saved());
    const metadata = (workflow as { metadata: Record<string, unknown> }).metadata;
    expect(metadata).not.toHaveProperty("planner");
    expect(metadata.workflow).toEqual({
      formatVersion: 5,
      agents: [{ id: "agent-1", name: "Developer" }],
    });
  });

  it("keeps the agents, which is the whole point of not dropping the old key", () => {
    const { workflow } = migrateWorkflow(saved());
    expect(agentProfiles(workflow as Workflow)).toEqual([{ id: "agent-1", name: "Developer" }]);
  });

  it("renames the one action whose id carried the old word", () => {
    const { workflow, notes } = migrateWorkflow(
      saved([
        { id: "n1", type: "agent", name: "Break it down", config: { actionKind: "plan-decompose" } },
        { id: "n2", type: "agent", name: "Build", config: { actionKind: "agent-step" } },
      ]),
    );
    const nodes = (workflow as { nodes: { config: { actionKind: string } }[] }).nodes;
    expect(nodes[0].config.actionKind).toBe("decompose");
    expect(nodes[1].config.actionKind).toBe("agent-step");
    // Said out loud rather than done silently: the author's file changed.
    expect(notes.join(" ")).toContain("Break it down");
  });

  it("opens cleanly once upgraded", () => {
    const { workflow } = migrateWorkflow(saved());
    expect(checkWorkflowCompatibility(workflow)).toEqual({ ok: true, version: 5 });
  });

  it("carries a version 2 file all the way through in one call", () => {
    // The chain has to reach the current format, not stop at the step that
    // existed when each migration was written.
    const ancient = { ...saved(), metadata: { planner: { formatVersion: 2 } } };
    const { workflow } = migrateWorkflow(ancient);
    expect(workflowFormatVersion(workflow)).toBe(WORKFLOW_FORMAT_VERSION);
  });
});

describe("the action ids the rename changed", () => {
  it("rewrites every one of them, not just the first that was noticed", () => {
    const { workflow, notes } = migrateWorkflow({
      id: "w1",
      nodes: [
        { id: "a", config: { actionKind: "plan-decompose" } },
        { id: "b", config: { actionKind: "release-publish-plan" } },
        // The id this one briefly had, which read as "publish the workflow".
        { id: "c", config: { actionKind: "release-publish-workflow" } },
      ],
      metadata: { planner: { formatVersion: 4 } },
    });
    const kinds = (workflow as { nodes: { config: { actionKind: string } }[] }).nodes.map(
      (node) => node.config.actionKind,
    );
    expect(kinds).toEqual(["decompose", "release-publish", "release-publish"]);
    expect(notes).toHaveLength(3);
  });
});
