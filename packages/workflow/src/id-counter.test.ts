/**
 * Ids that are unique in time.
 *
 * ANT-41. "Lowest unused" is unique among the blocks that exist and not among
 * the blocks that have existed, so deleting `agent-2` handed that id to the
 * next block created. Nothing on the canvas noticed, because at any one moment
 * every id was still distinct — but the id is what a session prints back as
 * `ANTHILL-STEP <run> <nonce> <block-id>`, and the journal keeps a day of
 * events tagged with the block each was attributed to. A number that comes
 * back on a different block makes past work resolve to a step that never did
 * it.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { nextIdFor, rememberIds } from "./id-counter.js";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    name: "A workflow",
    version: "1",
    nodes: [],
    edges: [],
    ...overrides,
  };
}

const ids = (...values: string[]) => values;

describe("handing out an id", () => {
  it("starts at one on an empty workflow", () => {
    expect(nextIdFor(workflow(), "agent", ids())).toBe("agent-1");
  });

  it("goes past what the workflow already holds", () => {
    expect(nextIdFor(workflow(), "agent", ids("agent-1", "agent-2"))).toBe("agent-3");
  });

  it("counts each prefix on its own", () => {
    const doc = rememberIds(workflow(), "agent-4");
    expect(nextIdFor(doc, "condition", ids("agent-4"))).toBe("condition-1");
  });

  it("ignores ids that are not of this shape at all", () => {
    // A template's ids, or a hand-written one. Not counter values, and not
    // guessed at.
    const doc = workflow();
    expect(nextIdFor(doc, "agent", ids("start", "agent-review", "agent-1"))).toBe("agent-2");
  });
});

describe("an id that has been used before", () => {
  it("is never handed out again after the block is deleted", () => {
    // The bug, in three lines.
    const held = rememberIds(workflow(), "agent-1", "agent-2");
    const afterDelete = ids("agent-1");
    expect(nextIdFor(held, "agent", afterDelete)).toBe("agent-3");
  });

  it("survives the file: the counter is in the workflow's own metadata", () => {
    const held = rememberIds(workflow(), "agent-1", "agent-2", "agent-3");
    const reopened = JSON.parse(JSON.stringify(held)) as Workflow;
    expect(nextIdFor(reopened, "agent", ids())).toBe("agent-4");
  });

  it("keeps counting from the file when the blocks are gone", () => {
    const held = rememberIds(workflow(), "agent-7");
    const reopened = JSON.parse(JSON.stringify(held)) as Workflow;
    expect(nextIdFor(reopened, "agent", ids())).toBe("agent-8");
  });
});

describe("a workflow written before any of this", () => {
  it("keeps every id it has", () => {
    // Nothing is renumbered on open: the counter is absent, so the existing
    // ids are the whole truth and the next id simply goes past them.
    const old = workflow({
      nodes: [
        { id: "agent-1", type: "agent", name: "One", config: {} },
        { id: "agent-5", type: "agent", name: "Five", config: {} },
      ],
    });
    expect(old.nodes.map((node) => node.id)).toEqual(["agent-1", "agent-5"]);
    expect(nextIdFor(old, "agent", old.nodes.map((node) => node.id))).toBe("agent-6");
  });

  it("is not fooled by a counter lower than the ids on disk", () => {
    // A file edited by hand, or written by a version that counted differently.
    // The remembered number is a floor, never a ceiling.
    const doc = rememberIds(workflow(), "agent-2");
    expect(nextIdFor(doc, "agent", ids("agent-9"))).toBe("agent-10");
  });

  it("shrugs off a metadata bag holding nonsense", () => {
    const doc = workflow({ metadata: { workflow: { idSeq: { agent: "seven" } } } });
    expect(nextIdFor(doc, "agent", ids("agent-1"))).toBe("agent-2");
  });
});

describe("remembering", () => {
  it("only ever moves the number up", () => {
    const doc = rememberIds(rememberIds(workflow(), "agent-9"), "agent-2");
    expect(nextIdFor(doc, "agent", ids())).toBe("agent-10");
  });

  it("leaves the workflow alone when there is nothing new to remember", () => {
    const doc = rememberIds(workflow(), "agent-3");
    expect(rememberIds(doc, "agent-1")).toBe(doc);
  });

  it("does not touch anything else in the metadata", () => {
    const doc = workflow({ metadata: { workflow: { formatVersion: 4, runRoot: "/tmp/repo" } } });
    const after = rememberIds(doc, "agent-1");
    expect((after.metadata as { workflow: Record<string, unknown> }).workflow).toMatchObject({
      formatVersion: 4,
      runRoot: "/tmp/repo",
    });
  });

  it("records an id it did not mint", () => {
    // A template's block, a pasted one, a draft's. They occupy numbers too.
    expect(nextIdFor(rememberIds(workflow(), "verify-block-4"), "verify-block", ids())).toBe(
      "verify-block-5",
    );
  });
});
