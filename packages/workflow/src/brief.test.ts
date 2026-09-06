import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_REPORT_SECTIONS,
  resolveBrief,
} from "./brief.js";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "wf", name: "Workflow", version: "1", nodes: [], edges: [], ...overrides };
}

describe("resolveBrief", () => {
  it("supplies the default constraints and report sections", () => {
    const brief = resolveBrief(workflow());
    expect(brief.constraints).toEqual([...DEFAULT_CONSTRAINTS]);
    expect(brief.report).toEqual([...DEFAULT_REPORT_SECTIONS]);
  });

  it("keeps the guardrail against faking a passing check", () => {
    expect(DEFAULT_CONSTRAINTS.join(" ")).toContain(
      "without fixing the underlying issue",
    );
  });

  it("lets a workflow replace the defaults entirely", () => {
    const brief = resolveBrief(
      workflow({ brief: { constraints: ["Only touch the parser."] } }),
    );
    expect(brief.constraints).toEqual(["Only touch the parser."]);
  });

  it("ignores blank entries and falls back when nothing usable remains", () => {
    const brief = resolveBrief(
      workflow({ brief: { constraints: ["  ", ""], report: ["  "] } }),
    );
    expect(brief.constraints).toEqual([...DEFAULT_CONSTRAINTS]);
    expect(brief.report).toEqual([...DEFAULT_REPORT_SECTIONS]);
  });

  it("falls back to the workflow description for the goal", () => {
    const brief = resolveBrief(workflow({ description: "Ship the parser fix." }));
    expect(brief.goal).toBe("Ship the parser fix.");
  });

  it("prefers an explicit goal over the description", () => {
    const brief = resolveBrief(
      workflow({ description: "A workflow", brief: { goal: "Make tests pass." } }),
    );
    expect(brief.goal).toBe("Make tests pass.");
  });

  it("invents no done criteria", () => {
    expect(resolveBrief(workflow()).doneCriteria).toEqual([]);
  });

  it("invents no context, assumptions, prohibitions or final action either", () => {
    const brief = resolveBrief(workflow());
    expect(brief.context).toBeUndefined();
    expect(brief.assumptions).toEqual([]);
    expect(brief.prohibitedActions).toEqual([]);
    expect(brief.finalAction).toBeUndefined();
  });

  it("carries the shared-context fields through", () => {
    const brief = resolveBrief(
      workflow({
        brief: {
          context: "A TypeScript monorepo with npm workspaces.",
          assumptions: ["The test suite is currently green."],
          prohibitedActions: ["Do not touch the database schema."],
          finalAction: "Open a pull request with the change.",
        },
      }),
    );
    expect(brief.context).toBe("A TypeScript monorepo with npm workspaces.");
    expect(brief.assumptions).toEqual(["The test suite is currently green."]);
    expect(brief.prohibitedActions).toEqual(["Do not touch the database schema."]);
    expect(brief.finalAction).toBe("Open a pull request with the change.");
  });

  it("drops blank entries from the shared-context lists", () => {
    const brief = resolveBrief(
      workflow({ brief: { assumptions: ["  ", "Real one", ""] } }),
    );
    expect(brief.assumptions).toEqual(["Real one"]);
  });
});
