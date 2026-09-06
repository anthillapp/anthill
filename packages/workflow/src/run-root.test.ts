/**
 * Remembering where a workflow's agents belong.
 *
 * ANT-46. The root has to survive a save and a reopen, or the author is asked
 * on every copy — and a question asked every time is one that gets skipped
 * exactly once, which is the whole failure this exists to prevent.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { runRoot, withRunRoot } from "./run-root.js";

const blank: Workflow = {
  id: "w",
  name: "W",
  version: "1",
  target: "claude-code",
  nodes: [],
  edges: [],
  metadata: { workflow: { formatVersion: 5, agents: [{ id: "agent-1", name: "Reader" }] } },
};

describe("the repository a workflow runs in", () => {
  it("is absent until something says otherwise", () => {
    expect(runRoot(blank)).toBeUndefined();
    expect(runRoot({ ...blank, metadata: undefined })).toBeUndefined();
  });

  it("is remembered and read back", () => {
    expect(runRoot(withRunRoot(blank, "/Users/someone/project"))).toBe("/Users/someone/project");
  });

  it("survives a save and a reopen", () => {
    const saved = JSON.parse(JSON.stringify(withRunRoot(blank, "/repo"))) as Workflow;
    expect(runRoot(saved)).toBe("/repo");
  });

  it("leaves everything else in the metadata alone", () => {
    const next = withRunRoot(blank, "/repo");
    const bag = (next.metadata as { workflow: Record<string, unknown> }).workflow;
    expect(bag.formatVersion).toBe(5);
    expect(bag.agents).toHaveLength(1);
  });

  it("can be forgotten", () => {
    const remembered = withRunRoot(blank, "/repo");
    expect(runRoot(withRunRoot(remembered, undefined))).toBeUndefined();
  });

  it("treats blank as nothing, so an empty answer is not a path", () => {
    expect(runRoot(withRunRoot(blank, "   "))).toBeUndefined();
  });

  it("does not mutate the workflow it was given", () => {
    const before = JSON.stringify(blank);
    withRunRoot(blank, "/repo");
    expect(JSON.stringify(blank)).toBe(before);
  });
});
