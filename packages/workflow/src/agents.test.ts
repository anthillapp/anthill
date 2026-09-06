import { describe, expect, it } from "vitest";
import { parseWorkflow, type Workflow, type WorkflowNode } from "@anthill/workflow-schema";

import {
  addAgentProfile,
  agentForNode,
  agentProfiles,
  agentSlug,
  assignAgent,
  assignedAgents,
  findAgentProfile,
  newAgentId,
  removeAgentProfile,
  stepsUsingAgent,
  updateAgentProfile,
  usesLibraryAgent,
  type AgentProfile,
} from "./agents.js";
import { agentConfig } from "./workflow.js";
import { compile } from "./compile.js";
import { WORKFLOW_FORMAT_VERSION, stampWorkflowFormat } from "./format.js";

function step(id: string, name: string, agentId?: string): WorkflowNode {
  return {
    id,
    type: "agent",
    name,
    config: {
      actionKind: "agent-step",
      task: "Do the work.",
      ...(agentId ? { agentId } : {}),
    },
  };
}

function makeWorkflow(agents: AgentProfile[] = [], nodes: WorkflowNode[] = []): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    metadata: { workflow: { agents } },
    nodes: [
      { id: "s", type: "start", name: "Start", config: {} },
      ...nodes,
      { id: "e", type: "end", name: "Done", config: {} },
    ],
    edges: [],
  };
}

describe("reading profiles", () => {
  it("finds nothing in a workflow that has no agents", () => {
    expect(agentProfiles({ ...makeWorkflow(), metadata: undefined })).toEqual([]);
  });

  it("skips an entry with no id, which has no identity to be", () => {
    const workflow = makeWorkflow();
    (workflow.metadata as Record<string, Record<string, unknown>>).workflow.agents = [
      { name: "Nameless" },
      { id: "agent-1", name: "Developer" },
    ];
    expect(agentProfiles(workflow).map((profile) => profile.id)).toEqual(["agent-1"]);
  });

  it("keeps only the first of two entries sharing an id", () => {
    const workflow = makeWorkflow();
    (workflow.metadata as Record<string, Record<string, unknown>>).workflow.agents = [
      { id: "agent-1", name: "First" },
      { id: "agent-1", name: "Second" },
    ];
    expect(agentProfiles(workflow)).toEqual([{ id: "agent-1", name: "First" }]);
  });

  it("carries the reserved settings bag through untouched", () => {
    const workflow = makeWorkflow([
      { id: "agent-1", name: "Dev", settings: { future: { tools: ["read"] } } },
    ]);
    expect(agentProfiles(workflow)[0].settings).toEqual({ future: { tools: ["read"] } });
  });
});

describe("creating profiles", () => {
  it("assigns an id that owes nothing to the name", () => {
    const { workflow, agentId } = addAgentProfile(makeWorkflow(), { name: "Developer" });
    expect(agentId).toBe("agent-1");
    expect(agentProfiles(workflow)).toEqual([{ id: "agent-1", name: "Developer" }]);
  });

  it("never reuses an id already taken", () => {
    const first = addAgentProfile(makeWorkflow(), { name: "A" });
    const second = addAgentProfile(first.workflow, { name: "B" });
    expect(second.agentId).toBe("agent-2");
    expect(agentProfiles(second.workflow)).toHaveLength(2);
  });

  it("does not collide with ids a migrated workflow brought with it", () => {
    expect(newAgentId(makeWorkflow(), ["agent-1", "role-dev"])).toBe("agent-2");
  });

  /**
   * ANT-49, the profile half of ANT-41. Deleting a profile a step still uses
   * is already refused, so no reference is left dangling — but an id that
   * comes back means two different agents wear one name across the life of a
   * file, in the journal and in anything written from it.
   */
  describe("an id a profile has already had", () => {
    it("is not handed to the next profile after the first is deleted", () => {
      const first = addAgentProfile(makeWorkflow(), { name: "A" });
      const second = addAgentProfile(first.workflow, { name: "B" });
      const afterDelete = removeAgentProfile(second.workflow, second.agentId);
      expect(agentProfiles(afterDelete)).toHaveLength(1);

      const third = addAgentProfile(afterDelete, { name: "C" });
      expect(third.agentId).toBe("agent-3");
    });

    it("is still gone after a save and a reopen", () => {
      const first = addAgentProfile(makeWorkflow(), { name: "A" });
      const emptied = removeAgentProfile(first.workflow, first.agentId);
      const reopened = JSON.parse(JSON.stringify(emptied)) as Workflow;
      expect(addAgentProfile(reopened, { name: "B" }).agentId).toBe("agent-2");
    });

    it("counts profiles apart from blocks, which wear the same prefix", () => {
      // A block called `agent-1` and a profile called `agent-1` can both exist
      // today; one shared tally would quietly change that.
      const workflow = makeWorkflow();
      const { agentId } = addAgentProfile(workflow, { name: "A" });
      expect(agentId).toBe("agent-1");
    });

    it("goes past profile ids that arrived with the file", () => {
      const opened = { ...makeWorkflow() };
      const seeded = addAgentProfile(opened, { name: "A" });
      const withHighId = {
        ...seeded.workflow,
        metadata: {
          ...(seeded.workflow.metadata as Record<string, unknown>),
          workflow: {
            ...((seeded.workflow.metadata as { workflow: Record<string, unknown> }).workflow),
            agents: [{ id: "agent-9", name: "Nine" }],
          },
        },
      } as Workflow;
      expect(addAgentProfile(withHighId, { name: "B" }).agentId).toBe("agent-10");
    });
  });

  it("leaves a new profile's optional fields out rather than empty", () => {
    const { workflow } = addAgentProfile(makeWorkflow(), { name: "Dev" });
    expect(agentProfiles(workflow)[0]).not.toHaveProperty("models");
  });
});

describe("editing profiles", () => {
  const base = () =>
    makeWorkflow([{ id: "agent-1", name: "Developer", models: { "claude-code": { id: "sonnet" } } }]);

  it("renames without touching the id", () => {
    const next = updateAgentProfile(base(), "agent-1", { name: "Engineer" });
    expect(agentProfiles(next)[0]).toEqual({
      id: "agent-1",
      name: "Engineer",
      models: { "claude-code": { id: "sonnet" } },
    });
  });

  it("keeps every step pointing at a renamed agent", () => {
    const workflow = makeWorkflow(
      [{ id: "agent-1", name: "Developer" }],
      [step("a", "Implement", "agent-1"), step("b", "Fix", "agent-1")],
    );
    const renamed = updateAgentProfile(workflow, "agent-1", { name: "Engineer" });
    expect(stepsUsingAgent(renamed, "agent-1").map((node) => node.id)).toEqual(["a", "b"]);
    expect(agentForNode(renamed, "a")?.name).toBe("Engineer");
  });

  /* The absence of a tool's key is the message, so an empty bag has to be able
     to send it — a patch that only ever added keys could not. */
  it("unanswers every tool when given an empty bag", () => {
    const next = updateAgentProfile(base(), "agent-1", { models: {} });
    expect(agentProfiles(next)[0]).not.toHaveProperty("models");
  });

  it("replaces the bag rather than merging into it", () => {
    const next = updateAgentProfile(base(), "agent-1", {
      models: { codex: { id: "gpt-5.6-sol" } },
    });
    expect(agentProfiles(next)[0].models).toEqual({ codex: { id: "gpt-5.6-sol" } });
  });

  it("leaves a field alone when the patch does not mention it", () => {
    const next = updateAgentProfile(base(), "agent-1", { name: "Engineer" });
    expect(agentProfiles(next)[0].models).toEqual({ "claude-code": { id: "sonnet" } });
  });

  it("does nothing for an id the workflow does not have", () => {
    const workflow = base();
    expect(updateAgentProfile(workflow, "agent-9", { name: "x" })).toBe(workflow);
  });
});

describe("deleting profiles", () => {
  it("removes one nobody is using", () => {
    const workflow = makeWorkflow([
      { id: "agent-1", name: "Developer" },
      { id: "agent-2", name: "Reviewer" },
    ]);
    expect(agentProfiles(removeAgentProfile(workflow, "agent-2"))).toEqual([
      { id: "agent-1", name: "Developer" },
    ]);
  });

  it("refuses while a step still points at it", () => {
    const workflow = makeWorkflow(
      [{ id: "agent-1", name: "Developer" }],
      [step("a", "Implement", "agent-1")],
    );
    // Deleting it would leave the step referencing an agent that is gone.
    expect(removeAgentProfile(workflow, "agent-1")).toBe(workflow);
  });

  it("allows it once the steps have been reassigned", () => {
    const workflow = makeWorkflow(
      [
        { id: "agent-1", name: "Developer" },
        { id: "agent-2", name: "Engineer" },
      ],
      [step("a", "Implement", "agent-1")],
    );
    const reassigned = assignAgent(workflow, "a", "agent-2");
    expect(agentProfiles(removeAgentProfile(reassigned, "agent-1"))).toEqual([
      { id: "agent-2", name: "Engineer" },
    ]);
  });

  it("names the steps that are in the way", () => {
    const workflow = makeWorkflow(
      [{ id: "agent-1", name: "Developer" }],
      [step("a", "Implement", "agent-1"), step("b", "Fix", "agent-1")],
    );
    expect(stepsUsingAgent(workflow, "agent-1").map((node) => node.name)).toEqual([
      "Implement",
      "Fix",
    ]);
  });

  it("drops the key entirely once the last profile goes", () => {
    const workflow = makeWorkflow([{ id: "agent-1", name: "Developer" }]);
    const empty = removeAgentProfile(workflow, "agent-1");
    const bag = (empty.metadata as Record<string, Record<string, unknown>>).workflow;
    expect(bag).not.toHaveProperty("agents");
  });
});

describe("assignment", () => {
  it("points a step at a profile by id and nothing else", () => {
    const workflow = makeWorkflow([{ id: "agent-1", name: "Developer" }], [step("a", "Implement")]);
    const assigned = assignAgent(workflow, "a", "agent-1");
    expect(agentConfig(assigned.nodes[1])).toMatchObject({ agentId: "agent-1" });
    expect(assigned.nodes[1].config).not.toHaveProperty("roleName");
  });

  it("groups several steps under the one agent that does them", () => {
    const workflow = makeWorkflow(
      [{ id: "agent-1", name: "Developer" }],
      [step("a", "Implement", "agent-1"), step("b", "Fix", "agent-1")],
    );
    const assignments = assignedAgents(workflow);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].stepIds).toEqual(["a", "b"]);
    expect(assignments[0].slug).toBe("developer");
  });

  it("leaves out a profile no step uses", () => {
    const workflow = makeWorkflow([
      { id: "agent-1", name: "Developer" },
      { id: "agent-2", name: "Unused" },
    ]);
    expect(assignedAgents(workflow)).toEqual([]);
  });

  it("skips a step whose agent is missing rather than inventing one", () => {
    const workflow = makeWorkflow([], [step("a", "Implement", "agent-gone")]);
    expect(assignedAgents(workflow)).toEqual([]);
    expect(agentForNode(workflow, "a")).toBeUndefined();
  });

  it("follows the order it is given, so files match the prompt", () => {
    const workflow = makeWorkflow(
      [
        { id: "agent-1", name: "Developer" },
        { id: "agent-2", name: "Reviewer" },
      ],
      [step("a", "Implement", "agent-1"), step("b", "Review", "agent-2")],
    );
    const reversed = [...workflow.nodes].reverse();
    expect(assignedAgents(workflow, reversed).map((item) => item.profile.id)).toEqual([
      "agent-2",
      "agent-1",
    ]);
  });
});

describe("agentSlug", () => {
  it("is the file-safe form of the display name", () => {
    expect(agentSlug({ id: "agent-1", name: "Code Reviewer" })).toBe("code-reviewer");
  });

  it("falls back to the id when the name has nothing usable in it", () => {
    expect(agentSlug({ id: "agent-1", name: "!!!" })).toBe("agent-1");
  });
});

describe("findAgentProfile", () => {
  it("returns nothing for a step with no agent", () => {
    expect(findAgentProfile(makeWorkflow(), undefined)).toBeUndefined();
  });
});

describe("compilation follows the profile, not the step", () => {
  const shared = (): Workflow => ({
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    brief: { doneCriteria: ["Done."] },
    metadata: {
      workflow: {
        agents: [
          {
            id: "agent-1",
            name: "Developer",
            model: "opus",
            role: "Implements and repairs",
            description: "One engineer carrying the change end to end.",
          },
        ],
      },
    },
    nodes: [
      { id: "s", type: "start", name: "Start", config: {} },
      step("a", "Implement", "agent-1"),
      step("b", "Fix review findings", "agent-1"),
      { id: "e", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "s", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "b", target: "e" },
    ],
  });

  it("writes one file for an agent used by two steps", () => {
    const { files } = compile(shared());
    expect(files.map((file) => file.path)).toEqual([".claude/agents/developer.md"]);
  });

  it("puts both steps in that one file", () => {
    const [file] = compile(shared()).files;
    expect(file.content).toContain("## Implement");
    expect(file.content).toContain("## Fix review findings");
  });

  it("uses the profile's model and description, not the step's", () => {
    const [file] = compile(shared()).files;
    expect(file.content).toContain("model: opus");
    expect(file.content).toContain(
      'description: "One engineer carrying the change end to end."',
    );
    expect(file.content).toContain("Implements and repairs");
  });

  it("renames the generated file when the agent is renamed", () => {
    const renamed = updateAgentProfile(shared(), "agent-1", { name: "Engineer" });
    expect(compile(renamed).files.map((file) => file.path)).toEqual([
      ".claude/agents/engineer.md",
    ]);
  });
});

describe("surviving save and load", () => {
  const authored = (): Workflow => {
    const created = addAgentProfile(makeWorkflow(), {
      name: "Developer",
      models: { "claude-code": { id: "opus" } },
      role: "Implements the change",
      description: "One engineer end to end.",
    });
    return assignAgent(
      { ...created.workflow, nodes: [...created.workflow.nodes, step("a", "Implement")] },
      "a",
      created.agentId,
    );
  };

  /** What saving and reopening a workflow actually does to it. */
  const roundTrip = (workflow: Workflow): Workflow =>
    parseWorkflow(JSON.parse(JSON.stringify(stampWorkflowFormat(workflow))));

  it("keeps every profile field through a save and a reload", () => {
    expect(agentProfiles(roundTrip(authored()))).toEqual([
      {
        id: "agent-1",
        name: "Developer",
        models: { "claude-code": { id: "opus" } },
        role: "Implements the change",
        description: "One engineer end to end.",
      },
    ]);
  });

  /*
   * Files written before the model was split by harness. They open in the new
   * shape and write back in it, and a value that cannot be attributed is
   * carried for a person to answer rather than assigned to a guess.
   */
  it("reads a pre-split model as an answer for the tool that offers it", () => {
    const legacy = makeWorkflow([{ id: "agent-1", name: "Developer", model: "opus" } as never]);
    const profile = agentProfiles(roundTrip(legacy))[0];
    expect(profile.models).toEqual({ "claude-code": { id: "opus" } });
    expect(profile).not.toHaveProperty("modelNeedsReview");
  });

  /* The first split stored a bare name per tool. Same answer, one fewer field. */
  it("reads the earlier per-tool shape, which had no reasoning effort", () => {
    const bagged = makeWorkflow([
      { id: "agent-1", name: "Developer", models: { "claude-code": "opus" } } as never,
    ]);
    expect(agentProfiles(roundTrip(bagged))[0].models).toEqual({
      "claude-code": { id: "opus" },
    });
  });

  /* The pass that allowed one answer in total. It becomes that tool's answer,
     and the tool it said nothing about stays unanswered. */
  it("reads the single-answer shape as the answer for its own tool", () => {
    const single = makeWorkflow([
      { id: "agent-1", name: "Developer", model: { target: "codex", id: "gpt-5.5" } } as never,
    ]);
    const profile = agentProfiles(roundTrip(single))[0];
    expect(profile.models).toEqual({ codex: { id: "gpt-5.5" } });
    expect(profile).not.toHaveProperty("modelNeedsReview");
  });

  it("holds an unattributable pre-split model for review instead of guessing", () => {
    const legacy = makeWorkflow([{ id: "agent-1", name: "Developer", model: "gpt-5" } as never]);
    const profile = agentProfiles(roundTrip(legacy))[0];
    expect(profile.modelNeedsReview).toBe("gpt-5");
    expect(profile).not.toHaveProperty("models");
  });

  it("does not invent a choice for a profile that never made one", () => {
    const legacy = makeWorkflow([{ id: "agent-1", name: "Developer" }]);
    const profile = agentProfiles(roundTrip(legacy))[0];
    expect(profile).not.toHaveProperty("models");
    expect(profile).not.toHaveProperty("modelNeedsReview");
  });

  /* A file may carry a stale older shape beside the current one. The current
     one is the answer; the other is what it was migrated from. */
  it("prefers the stored bag over an older shape left beside it", () => {
    const both = makeWorkflow([
      {
        id: "agent-1",
        name: "Developer",
        models: { "claude-code": { id: "opus" } },
        model: "haiku",
      } as never,
    ]);
    expect(agentProfiles(roundTrip(both))[0].models).toEqual({ "claude-code": { id: "opus" } });
  });

  it("keeps the step's reference, so the assignment survives too", () => {
    const reopened = roundTrip(authored());
    expect(agentForNode(reopened, "a")?.name).toBe("Developer");
  });

  it("keeps the reserved settings bag it does not understand", () => {
    const workflow = makeWorkflow([
      { id: "agent-1", name: "Dev", settings: { permissions: { readOnly: true } } },
    ]);
    expect(agentProfiles(roundTrip(workflow))[0].settings).toEqual({
      permissions: { readOnly: true },
    });
  });

  it("stamps the format without disturbing the agents beside it", () => {
    const stamped = stampWorkflowFormat(authored());
    const workflow = (stamped.metadata as Record<string, Record<string, unknown>>).workflow;
    expect(workflow.formatVersion).toBe(WORKFLOW_FORMAT_VERSION);
    expect(workflow.agents).toHaveLength(1);
  });
});

/**
 * A copy taken from the global agent library.
 *
 * ANT-17. A workflow is a file that has to keep meaning the same thing after
 * the library changes underneath it, is deleted, or is opened on a machine
 * that never had it — so what it takes is a copy with its own identity, and
 * `libraryId` is a note of where the copy came from, not the identity itself.
 */
describe("agents that came from the library", () => {
  it("keeps its own id, and remembers where it came from", () => {
    const { workflow, agentId } = addAgentProfile(makeWorkflow(), {
      name: "Reviewer",
      libraryId: "lib-1",
    });
    const profile = agentProfiles(workflow)[0];
    expect(profile.id).toBe(agentId);
    expect(profile.id).not.toBe("lib-1");
    expect(profile.libraryId).toBe("lib-1");
  });

  it("survives a save and load", () => {
    const { workflow } = addAgentProfile(makeWorkflow(), { name: "Reviewer", libraryId: "lib-1" });
    const reloaded = JSON.parse(JSON.stringify(workflow)) as typeof workflow;
    expect(agentProfiles(reloaded)[0].libraryId).toBe("lib-1");
  });

  it("keeps the back-reference through a rename here", () => {
    const { workflow, agentId } = addAgentProfile(makeWorkflow(), {
      name: "Reviewer",
      libraryId: "lib-1",
    });
    const renamed = updateAgentProfile(workflow, agentId, { name: "Careful Reviewer" });
    expect(agentProfiles(renamed)[0].libraryId).toBe("lib-1");
  });

  it("answers whether a workflow still holds a copy of a library profile", () => {
    const { workflow } = addAgentProfile(makeWorkflow(), { name: "Reviewer", libraryId: "lib-1" });
    expect(usesLibraryAgent(workflow, "lib-1")).toBe(true);
    expect(usesLibraryAgent(workflow, "lib-2")).toBe(false);
  });

  it("does not mistake a same-named agent for a copy", () => {
    // Names are editable on both sides and prove nothing about identity.
    const { workflow } = addAgentProfile(makeWorkflow(), { name: "Reviewer" });
    expect(usesLibraryAgent(workflow, "lib-1")).toBe(false);
  });
});
