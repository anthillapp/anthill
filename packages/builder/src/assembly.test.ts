/**
 * The order a drafted workflow assembles in.
 *
 * The rule under test is the one the audit found missing from the waiting
 * illustration and asked for on the real graph: nothing is revealed before it
 * can honestly exist. A connection never appears before both of its endpoints,
 * blocks appear in the order control will flow, and the timing is pure data —
 * the same workflow always assembles the same way.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { assemblyPlan } from "./assembly";

function make(
  nodes: [string, "start" | "agent" | "approval" | "end"][],
  edges: [string, string, string][],
): Workflow {
  return {
    id: "workflow-1",
    name: "Drafted",
    version: "1",
    target: "claude-code",
    nodes: nodes.map(([id, type], index) => ({
      id,
      type,
      name: id,
      config: type === "agent" ? { actionKind: "agent-step", task: "Do it" } : {},
      position: { x: index * 300, y: 0 },
    })),
    edges: edges.map(([id, source, target]) => ({ id, source, target })),
    metadata: { workflow: { formatVersion: 4 } },
  };
}

/** A shape with a branch, a loop back, and an approval — the audit's list. */
const branchedAndLooped = make(
  [
    ["start", "start"],
    ["plan", "agent"],
    ["build", "agent"],
    ["check", "agent"],
    ["approve", "approval"],
    ["end", "end"],
  ],
  [
    ["e1", "start", "plan"],
    ["e2", "plan", "build"],
    ["e3", "build", "check"],
    ["e4", "check", "approve"],
    ["e5", "approve", "end"],
    // The loop back: check routes failing work to build again.
    ["e-loop", "check", "build"],
  ],
);

describe("what appears when", () => {
  it("reveals Start before everything else", () => {
    const plan = assemblyPlan(branchedAndLooped);
    const startAt = plan.blocks.get("start") as number;
    for (const [id, at] of plan.blocks) {
      if (id !== "start") expect(at).toBeGreaterThan(startAt);
    }
  });

  it("reveals every block before any connection", () => {
    const plan = assemblyPlan(branchedAndLooped);
    const lastBlock = Math.max(...plan.blocks.values());
    for (const at of plan.edges.values()) {
      expect(at).toBeGreaterThan(lastBlock);
    }
  });

  it("never reveals a connection before both of its endpoints", () => {
    const plan = assemblyPlan(branchedAndLooped);
    for (const edge of branchedAndLooped.edges) {
      const at = plan.edges.get(edge.id) as number;
      expect(at).toBeGreaterThan(plan.blocks.get(edge.source) as number);
      expect(at).toBeGreaterThan(plan.blocks.get(edge.target) as number);
    }
  });

  it("walks the way control flows, not document order", () => {
    // Same workflow, nodes declared in reverse: the plan must not care.
    const reversed = make(
      [
        ["end", "end"],
        ["check", "agent"],
        ["build", "agent"],
        ["start", "start"],
      ],
      [
        ["e1", "start", "build"],
        ["e2", "build", "check"],
        ["e3", "check", "end"],
      ],
    );
    const plan = assemblyPlan(reversed);
    expect(plan.blocks.get("start")).toBeLessThan(plan.blocks.get("build") as number);
    expect(plan.blocks.get("build")).toBeLessThan(plan.blocks.get("check") as number);
    expect(plan.blocks.get("check")).toBeLessThan(plan.blocks.get("end") as number);
  });

  it("still reveals a block nothing points at", () => {
    const orphaned = make(
      [
        ["start", "start"],
        ["work", "agent"],
        ["stray", "agent"],
        ["end", "end"],
      ],
      [
        ["e1", "start", "work"],
        ["e2", "work", "end"],
      ],
    );
    const plan = assemblyPlan(orphaned);
    expect(plan.blocks.has("stray")).toBe(true);
  });

  it("is deterministic: the same workflow assembles the same way", () => {
    const a = assemblyPlan(branchedAndLooped);
    const b = assemblyPlan(branchedAndLooped);
    expect([...a.blocks.entries()]).toEqual([...b.blocks.entries()]);
    expect([...a.edges.entries()]).toEqual([...b.edges.entries()]);
    expect(a.total).toBe(b.total);
  });

  it("ends: the total covers the last element", () => {
    const plan = assemblyPlan(branchedAndLooped);
    const last = Math.max(...plan.blocks.values(), ...plan.edges.values());
    expect(plan.total).toBeGreaterThan(last);
  });
});
