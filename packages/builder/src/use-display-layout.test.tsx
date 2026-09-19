import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { withDisplayLayout } from "./display-layout";
import { useDisplayLayout } from "./use-display-layout";

/** A handover: three blocks, no positions, as a harness sends one. */
function chain(): Workflow {
  return {
    id: "handover",
    name: "Handover",
    version: "1",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "read", type: "agent", name: "Read", config: {} },
      { id: "end", type: "end", name: "End", config: {} },
    ],
    edges: [
      { id: "a", source: "start", target: "read" },
      { id: "b", source: "read", target: "end" },
    ],
  };
}

/** The same handover with a step added, as an edit or a poll delivers it. */
function grown(): Workflow {
  const next = chain();
  next.nodes.push({ id: "check", type: "agent", name: "Check", config: {} });
  next.edges.push({ id: "c", source: "read", target: "check" });
  return next;
}

/** A different document whose blocks happen to be called the same things. */
function other(): Workflow {
  return { ...chain(), id: "other", name: "Other", edges: [] };
}

const places = (workflow: Workflow) =>
  new Map(workflow.nodes.map((node) => [node.id, node.position]));

describe("drawing a handover across renders", () => {
  it("leaves every block where it was when a later render brings a changed graph", () => {
    const { result, rerender } = renderHook((workflow: Workflow) => useDisplayLayout(workflow), {
      initialProps: chain(),
    });
    const before = places(result.current);

    rerender(grown());

    for (const [id, at] of before) {
      expect(places(result.current).get(id)).toEqual(at);
    }
  });

  it("draws a different document as though it had drawn nothing before", () => {
    const { result, rerender } = renderHook((workflow: Workflow) => useDisplayLayout(workflow), {
      initialProps: chain(),
    });

    rerender(other());

    expect(places(result.current)).toEqual(places(withDisplayLayout(other())));
  });
});
