/**
 * What the launch list says about a file it has not opened.
 *
 * This reads the raw JSON on disk, not a workflow that has been through
 * `migrateWorkflow`. That difference is easy to forget and has already cost
 * one regression: after the metadata key was renamed, every workflow saved
 * before the rename listed as "0 agents" — not an error, just quietly wrong
 * about files the author could see were not empty.
 */

import { describe, expect, it } from "vitest";

import { describeWorkflow } from "./recents.js";

function saved(namespace: "workflow" | "planner", agents: number): unknown {
  return {
    id: "w1",
    name: "Implement, test, fix",
    target: "claude-code",
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [],
    metadata: {
      [namespace]: {
        formatVersion: namespace === "workflow" ? 5 : 4,
        agents: Array.from({ length: agents }, (_, i) => ({ id: `agent-${i}`, name: `A${i}` })),
      },
    },
  };
}

describe("summarising a workflow the list has not opened", () => {
  it("counts the agents of a current file", () => {
    expect(describeWorkflow(saved("workflow", 2))?.meta).toBe("3 blocks · 2 agents · Claude Code");
  });

  it("counts the agents of a file saved before the metadata key was renamed", () => {
    expect(describeWorkflow(saved("planner", 3))?.meta).toBe("3 blocks · 3 agents · Claude Code");
  });

  it("says one agent rather than 1 agents", () => {
    expect(describeWorkflow(saved("planner", 1))?.meta).toContain("1 agent ·");
  });

  it("gives up on something that is not a workflow at all", () => {
    expect(describeWorkflow({ nope: true })).toBeUndefined();
    expect(describeWorkflow("not json")).toBeUndefined();
  });
});

/**
 * Which library profiles a file on disk holds a copy of.
 *
 * ANT-17. The agent library says whether deleting a profile would leave any
 * workflow holding an orphaned copy, and the launch window has no workflow
 * open when it asks. The file is being parsed here anyway, so the answer
 * travels with the row.
 */
describe("library agents in the launch list", () => {
  const withProfiles = (agents: unknown[]) => ({
    id: "w1",
    name: "W",
    target: "claude-code",
    nodes: [{ id: "a" }],
    edges: [],
    metadata: { workflow: { formatVersion: 5, agents } },
  });

  it("reports the library ids its agents point back at", () => {
    const described = describeWorkflow(
      withProfiles([
        { id: "agent-1", name: "Reviewer", libraryId: "lib-1" },
        { id: "agent-2", name: "Builder", libraryId: "lib-2" },
      ]),
    );
    expect(described?.libraryAgentIds).toEqual(["lib-1", "lib-2"]);
  });

  it("says nothing when no agent came from the library", () => {
    const described = describeWorkflow(withProfiles([{ id: "agent-1", name: "Reviewer" }]));
    expect(described?.libraryAgentIds).toBeUndefined();
  });

  it("names a library profile once, however many copies point at it", () => {
    const described = describeWorkflow(
      withProfiles([
        { id: "agent-1", name: "Reviewer", libraryId: "lib-1" },
        { id: "agent-2", name: "Second reviewer", libraryId: "lib-1" },
      ]),
    );
    expect(described?.libraryAgentIds).toEqual(["lib-1"]);
  });

  it("still counts the agents it cannot trace to a library", () => {
    const described = describeWorkflow(
      withProfiles([{ id: "agent-1", name: "Reviewer", libraryId: "lib-1" }, { id: "agent-2" }]),
    );
    expect(described?.meta).toContain("2 agents");
  });
});
