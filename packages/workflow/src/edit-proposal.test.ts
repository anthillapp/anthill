/**
 * The edit-proposal contract, exercised the way an assistant will stress it.
 *
 * The properties that matter: a proposal is operations against real ids and
 * cannot silently drop what it did not mention; applying is pure and
 * all-or-nothing; a proposal whose result the schema would refuse is refused
 * whole; and layout survives — new blocks are placed beside their anchor, and
 * nobody else moves.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { agentProfiles } from "./agents.js";
import {
  EDIT_PROPOSAL_VERSION,
  applyEditProposal,
  parseEditProposal,
  type EditProposal,
} from "./edit-proposal.js";

function workflow(): Workflow {
  return {
    id: "workflow-1",
    name: "Implement and check",
    version: "1",
    target: "claude-code",
    brief: { goal: "Make the change safely." },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
      {
        id: "implement",
        type: "agent",
        name: "Implement",
        config: { actionKind: "agent-step", task: "Write it", agentId: "agent-1" },
        position: { x: 300, y: 0 },
      },
      {
        id: "check",
        type: "agent",
        name: "Check",
        config: { actionKind: "verify", task: "Check it", agentId: "agent-1" },
        position: { x: 600, y: 0 },
      },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 900, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "implement" },
      { id: "e2", source: "implement", target: "check" },
      { id: "e3", source: "check", target: "end" },
    ],
    metadata: {
      workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Developer" }] },
    },
  };
}

function proposal(ops: EditProposal["ops"], summary = "A change."): EditProposal {
  return { version: EDIT_PROPOSAL_VERSION, summary, ops };
}

describe("parsing a reply", () => {
  it("reads a proposal out of prose and fences", () => {
    const reply = [
      "Here is what I suggest:",
      "```json",
      JSON.stringify(proposal([{ op: "remove-block", id: "check" }])),
      "```",
      "Let me know.",
    ].join("\n");
    const parsed = parseEditProposal(reply);
    expect(parsed.ok).toBe(true);
  });

  it("refuses a version this Anthill does not speak", () => {
    const parsed = parseEditProposal(JSON.stringify({ version: 99, summary: "x", ops: [] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("version");
  });

  it("refuses an unknown operation by name and position", () => {
    const parsed = parseEditProposal(
      JSON.stringify({
        version: 1,
        summary: "x",
        ops: [{ op: "remove-block", id: "check" }, { op: "reboot-machine" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Operation 2");
  });

  it("reads an empty proposal as the refusal it is, summary intact", () => {
    // The contract's decline shape: nothing proposed, and the summary says
    // why. The caller shows it as a decline, never as a malformed reply.
    const parsed = parseEditProposal(
      JSON.stringify({ version: 1, summary: "That is a task, not a graph edit.", ops: [] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.proposal.ops).toHaveLength(0);
    expect(parsed.proposal.summary).toContain("not a graph edit");
  });
});

describe("applying a proposal", () => {
  it("splits one block into scoped steps with handoffs — the issue's own example", () => {
    const result = applyEditProposal(
      workflow(),
      proposal([
        { op: "add-block", ref: "ui", blockType: "agent", name: "Implement the UI", near: "implement", config: { actionKind: "agent-step", task: "The screens" } },
        { op: "add-block", ref: "api", blockType: "agent", name: "Implement the API", near: "implement", config: { actionKind: "agent-step", task: "The endpoints" } },
        { op: "update-block", id: "implement", name: "Split the work", config: { task: "Divide and hand off" } },
        { op: "connect", source: "implement", target: "ui" },
        { op: "connect", source: "implement", target: "api" },
        { op: "connect", source: "ui", target: "check" },
        { op: "connect", source: "api", target: "check" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes).toHaveLength(6);
    // New blocks got real ids that collide with nothing.
    const ids = result.workflow.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    // And the refs resolved in the connections.
    const targets = result.workflow.edges.filter((edge) => edge.source === "implement").map((e) => e.target);
    expect(targets).toHaveLength(3);
  });

  it("never mutates the workflow it was given", () => {
    const before = workflow();
    const snapshot = JSON.stringify(before);
    applyEditProposal(before, proposal([{ op: "remove-block", id: "check" }]));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("keeps every unrelated id and position exactly as it was", () => {
    const before = workflow();
    const result = applyEditProposal(
      before,
      proposal([{ op: "add-block", ref: "review", blockType: "agent", name: "Review", near: "check" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of before.nodes) {
      const after = result.workflow.nodes.find((item) => item.id === node.id);
      expect(after?.position).toEqual(node.position);
      expect(after?.name).toBe(node.name);
    }
  });

  it("places a new block beside its anchor rather than re-laying anything out", () => {
    const result = applyEditProposal(
      workflow(),
      proposal([{ op: "add-block", ref: "n", blockType: "agent", name: "New", near: "implement" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.workflow.nodes.find((node) => node.name === "New");
    expect(added?.position?.x).toBeGreaterThan(300);
  });

  /**
   * ANT-39. "One block-width to the right of the anchor" is the right first
   * guess and a bad only guess: an anchor almost always already has a
   * successor sitting exactly there, so adding a step "after implement"
   * dropped the new block on top of the block that followed it. On a
   * twenty-block workflow the result was a pile rather than a diagram.
   */
  describe("where a new block lands", () => {
    /** Two blocks overlap if they are close on both axes. */
    const overlapping = (a: Workflow) => {
      const spots = a.nodes.flatMap((node) => (node.position ? [node.position] : []));
      return spots.some((one, index) =>
        spots.some(
          (two, other) =>
            other > index && Math.abs(one.x - two.x) < 190 && Math.abs(one.y - two.y) < 120,
        ),
      );
    };

    it("does not land on the block already sitting beside the anchor", () => {
      const before = workflow();
      // `end` is at x 600, right where a block added after `implement` would go.
      const result = applyEditProposal(
        before,
        proposal([
          { op: "add-block", ref: "n", blockType: "agent", name: "New", near: "implement" },
        ]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(overlapping(result.workflow)).toBe(false);
    });

    it("keeps a run of added blocks apart from each other", () => {
      const result = applyEditProposal(
        workflow(),
        proposal([
          { op: "add-block", ref: "a", blockType: "agent", name: "A", near: "implement" },
          { op: "add-block", ref: "b", blockType: "agent", name: "B", near: "implement" },
          { op: "add-block", ref: "c", blockType: "agent", name: "C", near: "implement" },
        ]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(overlapping(result.workflow)).toBe(false);
    });

    it("stays in its anchor's column, going down rather than further right", () => {
      // The slot to the right belongs to whatever comes next in the sequence;
      // a sibling branch belongs beside its sibling.
      const result = applyEditProposal(
        workflow(),
        proposal([
          { op: "add-block", ref: "a", blockType: "agent", name: "A", near: "implement" },
          { op: "add-block", ref: "b", blockType: "agent", name: "B", near: "implement" },
        ]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const a = result.workflow.nodes.find((node) => node.name === "A");
      const b = result.workflow.nodes.find((node) => node.name === "B");
      expect(a?.position?.x).toBe(b?.position?.x);
      expect(b?.position?.y).toBeGreaterThan(a?.position?.y ?? 0);
    });

    it("leaves every existing block exactly where the author put it", () => {
      const before = workflow();
      const result = applyEditProposal(
        before,
        proposal([
          { op: "add-block", ref: "n", blockType: "agent", name: "New", near: "implement" },
        ]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const node of before.nodes) {
        const after = result.workflow.nodes.find((item) => item.id === node.id);
        expect(after?.position).toEqual(node.position);
      }
    });
  });

  it("refuses the whole proposal when one operation names a ghost", () => {
    const result = applyEditProposal(
      workflow(),
      proposal([
        { op: "update-block", id: "implement", name: "Renamed" },
        { op: "remove-block", id: "does-not-exist" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("does-not-exist");
  });

  it("refuses to remove the start or end of the workflow", () => {
    for (const id of ["start", "end"]) {
      const result = applyEditProposal(workflow(), proposal([{ op: "remove-block", id }]));
      expect(result.ok).toBe(false);
    }
  });

  it("takes a removed block's connections with it, each as a visible change", () => {
    const result = applyEditProposal(workflow(), proposal([{ op: "remove-block", id: "check" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges.some((edge) => edge.source === "check" || edge.target === "check")).toBe(false);
    const kinds = result.changes.map((change) => change.kind);
    expect(kinds.filter((kind) => kind === "disconnected")).toHaveLength(2);
    expect(kinds).toContain("block-removed");
  });

  it("cannot be talked into a document the schema would refuse", () => {
    // The op set is deliberately too narrow to express an unloadable
    // workflow: names are required non-empty at parse, an empty rename is a
    // no-op at apply, types come from a fixed union, and ids are issued, not
    // accepted. The schema check behind all this is a net for future ops, so
    // what this test pins is the narrowness itself.
    const result = applyEditProposal(workflow(), {
      version: EDIT_PROPOSAL_VERSION,
      summary: "x",
      ops: [{ op: "update-block", id: "implement", name: "" as unknown as string, config: {} }],
    } as EditProposal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The empty rename changed nothing rather than producing a nameless block.
    expect(result.workflow.nodes.find((n) => n.id === "implement")?.name).toBe("Implement");
  });

  it("leaves semantic gaps to the Problems panel, as authoring states", () => {
    // A block added now and wired next is a normal in-progress edit; refusing
    // it would make incremental editing impossible. The canvas's validation
    // reports it inline after acceptance instead.
    const result = applyEditProposal(
      workflow(),
      proposal([{ op: "add-block", ref: "lone", blockType: "agent", name: "Not wired yet" }]),
    );
    expect(result.ok).toBe(true);
  });

  it("reports every change it made, in order", () => {
    const result = applyEditProposal(
      workflow(),
      proposal([
        { op: "update-block", id: "implement", name: "Build" },
        { op: "update-connection", edgeId: "e2", label: "send to check" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([
      { kind: "block-updated", id: "implement", name: "Build" },
      { kind: "connection-updated", edgeId: "e2" },
    ]);
  });
});

/**
 * Ambiguity has its own answer, and it is not a guess.
 *
 * "Split this task into subagents" names no block and no division of work.
 * Folded into the refusal shape it came back as a decline, leaving the author
 * to work out what would have satisfied it; answered helpfully it came back as
 * a proposal against a block somebody picked for them (ANT-36). A question is
 * a third outcome, and the parser holds it to carrying no change.
 */
describe("a reply that asks instead of proposing", () => {
  const ask = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: EDIT_PROPOSAL_VERSION,
      summary: "The request does not say which step to split.",
      question: "Which step should be split — Implement, or Run tests?",
      ops: [],
      ...extra,
    });

  it("is read as a question, not as a refusal", () => {
    const parsed = parseEditProposal(ask());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.proposal.question).toBe("Which step should be split — Implement, or Run tests?");
    expect(parsed.proposal.ops).toEqual([]);
  });

  it("refuses a reply that asks and changes something at once", () => {
    const parsed = parseEditProposal(
      ask({ ops: [{ op: "remove-block", id: "implement" }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("one or the other");
  });

  it("leaves an ordinary refusal exactly as it was", () => {
    const parsed = parseEditProposal(
      JSON.stringify({
        version: EDIT_PROPOSAL_VERSION,
        summary: "That is not a change to this diagram.",
        ops: [],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.proposal.question).toBeUndefined();
    expect(parsed.proposal.ops).toEqual([]);
  });

  it("leaves a proposal without a question exactly as it was", () => {
    const parsed = parseEditProposal(
      JSON.stringify({
        version: EDIT_PROPOSAL_VERSION,
        summary: "Removes the old step.",
        ops: [{ op: "remove-block", id: "implement" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.proposal.question).toBeUndefined();
    expect(parsed.proposal.ops).toHaveLength(1);
  });
});

/**
 * The assistant can say who carries a step out (ANT-112).
 *
 * It could add agent steps and had no operation for agents at all, so every
 * step it added was born unassigned and the graph stopped validating — while
 * the answer said "applied to the canvas".
 */
describe("agents", () => {
  const propose = (ops: unknown[]) =>
    parseEditProposal(JSON.stringify({
      version: EDIT_PROPOSAL_VERSION,
      summary: "Add a QA step.",
      ops,
    }));

  it("assigns an agent the workflow already has", () => {
    const parsed = propose([
      { op: "add-block", ref: "qa", blockType: "agent", name: "Run the suite",
        config: { actionKind: "agent-step", task: "Run it", agentId: "agent-1" } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const added = applied.workflow.nodes.find((node) => node.name === "Run the suite");
    expect(added?.config).toMatchObject({ agentId: "agent-1" });
  });

  it("creates an agent the workflow does not have, and lists it as a change", () => {
    const parsed = propose([
      { op: "add-agent", ref: "qa", name: "QA Engineer", role: "Drives the app" },
      { op: "add-block", ref: "step", blockType: "agent", name: "Run the suite",
        config: { actionKind: "agent-step", task: "Run it", agentId: "qa" } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const profiles = agentProfiles(applied.workflow);
    const qa = profiles.find((profile) => profile.name === "QA Engineer");
    expect(qa).toBeTruthy();
    expect(qa?.role).toBe("Drives the app");
    // The block points at the real id, not at the proposal's handle.
    const added = applied.workflow.nodes.find((node) => node.name === "Run the suite");
    expect(added?.config).toMatchObject({ agentId: qa?.id });
    expect((added?.config as { agentId?: string }).agentId).not.toBe("qa");

    // Named before the author accepts it: an agent that appeared without being
    // listed would be a change nobody agreed to.
    expect(applied.changes).toContainEqual(
      expect.objectContaining({ kind: "agent-added", name: "QA Engineer" }),
    );
  });

  it("keeps the agents the workflow already had", () => {
    const parsed = propose([{ op: "add-agent", ref: "qa", name: "QA Engineer" }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(agentProfiles(applied.workflow).map((profile) => profile.name)).toEqual([
      "Developer",
      "QA Engineer",
    ]);
  });

  it("lets one new agent carry several steps", () => {
    const parsed = propose([
      { op: "add-agent", ref: "qa", name: "QA Engineer" },
      { op: "add-block", ref: "a", blockType: "agent", name: "Drive it",
        config: { actionKind: "agent-step", task: "Drive", agentId: "qa" } },
      { op: "add-block", ref: "b", blockType: "agent", name: "Watch it",
        config: { actionKind: "agent-step", task: "Watch", agentId: "qa" } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const ids = ["Drive it", "Watch it"].map(
      (name) => (applied.workflow.nodes.find((node) => node.name === name)?.config as { agentId?: string }).agentId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(agentProfiles(applied.workflow)).toHaveLength(2);
  });

  it("assigns an agent to a step that already exists", () => {
    const parsed = propose([
      { op: "add-agent", ref: "qa", name: "QA Engineer" },
      { op: "update-block", id: "check", config: { agentId: "qa" } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const qa = agentProfiles(applied.workflow).find((profile) => profile.name === "QA Engineer");
    const check = applied.workflow.nodes.find((node) => node.id === "check");
    expect((check?.config as { agentId?: string }).agentId).toBe(qa?.id);
  });

  it("refuses a proposal that gives an agent and a block the same handle", () => {
    const parsed = propose([
      { op: "add-agent", ref: "same", name: "QA Engineer" },
      { op: "add-block", ref: "same", blockType: "agent", name: "Run it",
        config: { actionKind: "agent-step", task: "Run" } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyEditProposal(workflow(), parsed.proposal);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error).toContain("reuses the ref");
  });

  it("refuses an add-agent with no name to call it by", () => {
    const parsed = propose([{ op: "add-agent", ref: "qa" }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("add-agent");
  });
});
