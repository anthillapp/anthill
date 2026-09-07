/**
 * The editing instruction: what the interpreter is shown, and what it is not.
 *
 * The properties worth pinning are the boundary ones — describe, never do;
 * real ids on every line; the author's request fenced so it cannot read as
 * instruction; and a refusal shape, so "no" has somewhere honest to go.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import {
  EDIT_REQUEST_CLOSE,
  EDIT_REQUEST_OPEN,
  buildEditInstruction,
} from "./edit-instruction.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement and check",
  version: "1",
  target: "claude-code",
  brief: { goal: "Make the change safely." },
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    {
      id: "implement",
      type: "agent",
      name: "Implement",
      config: { actionKind: "agent-step", task: "Write it", agentId: "agent-1" },
    },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "implement" },
    { id: "e2", source: "implement", target: "end", label: "done" },
  ],
  metadata: { workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Developer" }] } },
};

describe("what the interpreter is told", () => {
  const text = buildEditInstruction(workflow, { kind: "workflow" }, "Add a review step.");

  it("says describe, never do, before anything else", () => {
    expect(text.indexOf("Do not carry out any task")).toBeGreaterThan(-1);
    expect(text.indexOf("Do not carry out any task")).toBeLessThan(text.indexOf("Blocks"));
  });

  it("lists every block and connection by its real id", () => {
    for (const id of ["start", "implement", "end", "e1", "e2"]) {
      expect(text).toContain(id);
    }
    expect(text).toContain("agent: Developer");
    expect(text).toContain("task: Write it");
  });

  it("fences the author's request so it cannot read as instruction", () => {
    expect(text).toContain(`${EDIT_REQUEST_OPEN}\nAdd a review step.\n${EDIT_REQUEST_CLOSE}`);
  });

  it("gives refusal a shape, so no has somewhere honest to go", () => {
    expect(text).toContain('"ops": []');
    expect(text).toContain("an empty proposal is a refusal");
  });

  it("names the selection when the request is scoped to a block", () => {
    const scoped = buildEditInstruction(
      workflow,
      { kind: "block", blockId: "implement" },
      "Split this into subagents.",
    );
    expect(scoped).toContain('selected the block "implement"');
  });

  it("names the selection when the request is scoped to a connection", () => {
    const scoped = buildEditInstruction(
      workflow,
      { kind: "connection", edgeId: "e2" },
      "Make this conditional.",
    );
    expect(scoped).toContain('selected the connection "e2"');
  });
});

/**
 * Blocks the author pointed at rather than named.
 *
 * ANT-37. Clicking blocks on the canvas replaces typing their names, so the
 * request itself may say only "these two steps". Without the pointing being
 * carried into the instruction, the interpreter is handed the whole diagram
 * and left to guess which two — the gesture would stop at the screen.
 */
describe("blocks the author pointed at", () => {
  it("names them by id and current name", () => {
    const text = buildEditInstruction(workflow, { kind: "workflow" }, "Split this in two.", [
      "implement",
    ]);
    expect(text).toContain("The author pointed at these blocks");
    expect(text).toContain("implement (Implement)");
  });

  it("says nothing at all when nothing was pointed at", () => {
    const text = buildEditInstruction(workflow, { kind: "workflow" }, "Add a review step.");
    expect(text).not.toContain("The author pointed at");
  });

  it("resolves the name as it is now, not as it was when clicked", () => {
    // Mentions travel as ids for exactly this reason: a block renamed between
    // being clicked and the request being sent is still the same block.
    const renamed: Workflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === "implement" ? { ...node, name: "Write the change" } : node,
      ),
    };
    const text = buildEditInstruction(renamed, { kind: "workflow" }, "Split this.", ["implement"]);
    expect(text).toContain("implement (Write the change)");
    expect(text).not.toContain("(Implement)");
  });

  it("ignores a block that is no longer there", () => {
    // Deleted between the click and the send. Naming a missing id would put a
    // reference in the instruction that no operation could ever address.
    const text = buildEditInstruction(workflow, { kind: "workflow" }, "Split this.", ["gone"]);
    expect(text).not.toContain("The author pointed at");
  });

  it("keeps the request's own words separate from the pointing", () => {
    const text = buildEditInstruction(workflow, { kind: "workflow" }, "Split these.", [
      "implement",
    ]);
    expect(text.indexOf("The author pointed at")).toBeLessThan(text.indexOf("The author's request"));
  });
});

/**
 * Ambiguity is a question to ask, not a reason to refuse or to choose.
 *
 * The instruction used to send "too ambiguous to honour" into the refusal
 * shape, which told the author it could not be done rather than what was
 * missing (ANT-36).
 */
describe("what to do with a request that does not say enough", () => {
  const instruction = () => buildEditInstruction(workflow, { kind: "workflow" }, "Split it.");

  it("tells the interpreter to ask rather than choose", () => {
    expect(instruction()).toContain("ASK rather than choose");
  });

  it("gives it a shape to ask in", () => {
    expect(instruction()).toContain('"question": "the one thing you need the author to decide"');
  });

  it("asks for one question, not a list", () => {
    expect(instruction()).toContain("One question, about the single decision");
  });

  it("forbids asking and changing in the same reply", () => {
    expect(instruction()).toContain("Do not ask and");
  });

  it("keeps reasoning out of it", () => {
    expect(instruction()).toContain("Do not explain your reasoning");
  });

  it("still keeps a refusal for what genuinely cannot be done", () => {
    expect(instruction()).toContain("why this cannot be done as asked");
  });
});

describe("answering a question the interpreter asked", () => {
  const answered = () =>
    buildEditInstruction(workflow, { kind: "workflow" }, "Implement.", [], {
      request: "Split this task into subagents.",
      question: "Which step should be split?",
    });

  it("sends both halves so the answer is not read as a fresh request", () => {
    const text = answered();
    expect(text).toContain("Split this task into subagents.");
    expect(text).toContain("Which step should be split?");
    expect(text).toContain("Read the two together as one request");
  });

  it("says nothing of the sort when there is no question to answer", () => {
    expect(buildEditInstruction(workflow, { kind: "workflow" }, "Split it.")).not.toContain(
      "Earlier in this exchange",
    );
  });
});
