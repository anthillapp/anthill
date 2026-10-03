import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { WORKFLOW_TEMPLATES, addOutput } from "@anthill/workflow";

import { PORT_OFFSET, labelHalfSize } from "./geometry";
import { withDisplayLayout } from "./display-layout";
import type { WorkflowNode } from "@anthill/workflow-schema";

import {
  OUTCOME_STYLES,
  PILL_MAX,
  PILL_SIZE,
  STEP_SIZE,
  blockColor,
  blockSize,
  SNAP_RADIUS,
  blockRect,
  buildCanvasModel,
  snapTarget,
  dropPosition,
  snapToGrid,
} from "./workflow-canvas-model";

function makeWorkflow(): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 200 } },
      {
        id: "a",
        type: "agent",
        name: "Implement",
        config: { actionKind: "agent-step", agentId: "r1", task: "x" },
        position: { x: 200, y: 180 },
      },
      {
        id: "b",
        type: "agent",
        name: "Review",
        config: { actionKind: "llm-review", agentId: "r2", task: "y" },
        position: { x: 500, y: 180 },
      },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 800, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b", label: "send to review" },
      { id: "e3", source: "b", target: "end", label: "approved" },
    ],
  };
}

describe("blockRect", () => {
  it("uses the step size for a step", () => {
    expect(blockRect(makeWorkflow().nodes[1])).toEqual({ left: 200, top: 180, ...STEP_SIZE });
  });

  it("uses the pill size for start and end", () => {
    expect(blockRect(makeWorkflow().nodes[0])).toMatchObject(PILL_SIZE);
    expect(blockRect(makeWorkflow().nodes[3])).toMatchObject(PILL_SIZE);
  });

  it("treats a block with no position as the origin", () => {
    expect(blockRect({ id: "x", type: "agent", name: "n", config: {} })).toMatchObject({
      left: 0,
      top: 0,
    });
  });
});

describe("blockColor", () => {
  it("colours a step by the category of its action", () => {
    const workflow = makeWorkflow();
    // agent-step is "build", llm-review is "verify".
    expect(blockColor(workflow.nodes[1])).toBe("#6b5bd2");
    expect(blockColor(workflow.nodes[2])).toBe("#d8a21a");
  });

  it("gives an approval gate the stop colour, because it waits for a person", () => {
    expect(
      blockColor({ id: "g", type: "approval", name: "Gate", config: {} }),
    ).toBe("#ec3013");
  });

  it("falls back to neutral for a step with no action chosen yet", () => {
    expect(blockColor({ id: "x", type: "agent", name: "n", config: {} })).toBe("#605d5d");
  });
});

describe("buildCanvasModel", () => {
  it("builds a path for every connected output", () => {
    const model = buildCanvasModel(makeWorkflow());
    expect(model.connected.map((path) => path.output.id)).toEqual(["e1", "e2", "e3"]);
    expect(model.pending).toEqual([]);
  });

  it("starts each path at its block's port", () => {
    const model = buildCanvasModel(makeWorkflow());
    const fromA = model.connected.find((path) => path.nodeId === "a");
    // One output, so the port sits centred just outside the right edge.
    expect(fromA?.port).toEqual({
      x: 200 + STEP_SIZE.w + PORT_OFFSET,
      y: 180 + STEP_SIZE.h / 2,
      side: "right",
    });
  });

  it("spreads ports apart when a block has several outputs", () => {
    const { workflow } = addOutput(makeWorkflow(), "a", "rework", "send back");
    const model = buildCanvasModel(workflow);
    const ports = [...model.connected, ...model.pending]
      .filter((path) => path.nodeId === "a")
      .map((path) => path.port.y);
    expect(new Set(ports).size).toBe(2);
  });

  it("draws a stub for an output that leads nowhere yet", () => {
    const { workflow, outputId } = addOutput(makeWorkflow(), "b", "question", "ask");
    const model = buildCanvasModel(workflow);
    const stub = model.pending.find((path) => path.output.id === outputId);
    expect(stub?.path).toContain("L ");
    expect(stub?.style).toEqual(OUTCOME_STYLES.question);
  });

  it("styles a path by the meaning of its output", () => {
    const workflow = makeWorkflow();
    workflow.edges[1].kind = "rework";
    const model = buildCanvasModel(workflow);
    expect(model.connected[1].style).toEqual(OUTCOME_STYLES.rework);
    expect(model.connected[1].style.dash).toBe("7 5");
  });

  it("skips a path whose target is missing rather than drawing into nothing", () => {
    const workflow = makeWorkflow();
    workflow.edges.push({ id: "ghost", source: "a", target: "nowhere" });
    const model = buildCanvasModel(workflow);
    expect(model.connected.some((path) => path.output.id === "ghost")).toBe(false);
  });

  it("keeps the middle of the line clear for the bend handle", () => {
    for (const path of buildCanvasModel(makeWorkflow()).connected) {
      const gap = Math.hypot(
        path.label.x - path.geometry.mid.x,
        path.label.y - path.geometry.mid.y,
      );
      expect(gap).toBeGreaterThan(9);
    }
  });

  it("keeps labels off the blocks", () => {
    const model = buildCanvasModel(makeWorkflow());
    const rects = [...model.rects.values()];
    for (const path of model.connected) {
      const onABlock = rects.some(
        (rect) =>
          path.label.x > rect.left &&
          path.label.x < rect.left + rect.w &&
          path.label.y > rect.top &&
          path.label.y < rect.top + rect.h,
      );
      expect(onABlock).toBe(false);
    }
  });

  it("puts a port where the author moved it", () => {
    const workflow = makeWorkflow();
    workflow.edges[1].port = { u: 0.5, v: 1 };
    const model = buildCanvasModel(workflow);
    const path = model.connected.find((item) => item.output.id === "e2");
    expect(path?.port.side).toBe("bottom");
    expect(path?.port.y).toBe(180 + STEP_SIZE.h + PORT_OFFSET);
  });

  it("leaves the other ports of a block where they were when one is moved", () => {
    const { workflow } = addOutput(makeWorkflow(), "a", "rework", "send back");
    const before = buildCanvasModel(workflow).connected.find(
      (item) => item.output.id === "e2",
    )?.port;

    workflow.nodes[1].config.pendingOutputs = [
      { id: "out-1", kind: "rework", label: "send back", port: { u: 0, v: 0.5 } },
    ];
    const after = buildCanvasModel(workflow).connected.find(
      (item) => item.output.id === "e2",
    )?.port;

    // The moved port no longer takes a slot, so the one left is centred.
    expect(after).not.toEqual(before);
    expect(after?.y).toBe(180 + STEP_SIZE.h / 2);
  });

  it("draws a stepped line when the output asks for one", () => {
    const workflow = makeWorkflow();
    workflow.edges[1].routing = "orthogonal";
    const model = buildCanvasModel(workflow);
    const path = model.connected.find((item) => item.output.id === "e2");
    expect(path?.geometry.path).not.toContain("C");
    expect(path?.geometry.turn).toBeDefined();
  });

  it("applies the author's bend to the line", () => {
    const workflow = makeWorkflow();
    const plain = buildCanvasModel(workflow).connected.find(
      (item) => item.output.id === "e2",
    );
    workflow.edges[1].bend = { along: 0, across: -0.3 };
    const bent = buildCanvasModel(workflow).connected.find(
      (item) => item.output.id === "e2",
    );
    expect(bent?.geometry.mid.y).toBeLessThan(plain!.geometry.mid.y);
  });

  it("honours an anchor so the arrowhead lands where it was pointed", () => {
    const workflow = makeWorkflow();
    workflow.edges[1].anchor = { u: 0.5, v: 0 };
    const model = buildCanvasModel(workflow);
    const path = model.connected.find((item) => item.output.id === "e2");
    expect(path?.geometry.to.side).toBe("top");
  });
});

describe("snapToGrid", () => {
  it("rounds to the grid the canvas draws", () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(10)).toBe(0);
    expect(snapToGrid(12)).toBe(22);
    expect(snapToGrid(45)).toBe(44);
  });
});

describe("dropPosition", () => {
  const canvas = { width: 900, height: 700 };

  it("centres the card on the cursor, snapped to the grid", () => {
    const position = dropPosition({ x: 400, y: 300 }, canvas);
    expect(position.x % 22).toBe(0);
    expect(position.y % 22).toBe(0);
    expect(Math.abs(position.x - (400 - STEP_SIZE.w / 2))).toBeLessThan(22);
  });

  it("keeps a block dropped at the edge inside the canvas", () => {
    const topLeft = dropPosition({ x: -500, y: -500 }, canvas);
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(44);

    const bottomRight = dropPosition({ x: 5000, y: 5000 }, canvas);
    expect(bottomRight.x).toBeLessThanOrEqual(canvas.width - STEP_SIZE.w);
    expect(bottomRight.y).toBeLessThanOrEqual(canvas.height - STEP_SIZE.h);
  });

  it("does not produce a negative position on a tiny canvas", () => {
    const position = dropPosition({ x: 10, y: 10 }, { width: 100, height: 100 });
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
  });
});

describe("snapTarget", () => {
  const nodes = makeWorkflow().nodes;
  const anything = () => true;

  it("finds the block a point is inside", () => {
    expect(snapTarget({ x: 260, y: 220 }, nodes, anything)?.node.id).toBe("a");
  });

  it("finds a block a point is merely near", () => {
    // Releasing a connection is a gesture, not a click on a rectangle.
    const justOutside = { x: 200 + STEP_SIZE.w + 30, y: 220 };
    expect(snapTarget(justOutside, nodes, anything)?.node.id).toBe("a");
  });

  it("finds nothing in open space", () => {
    expect(snapTarget({ x: 2000, y: 2000 }, nodes, anything)).toBeUndefined();
  });

  it("prefers the nearer of two blocks, not whichever is drawn on top", () => {
    // Between "a" (ends at x=396) and "b" (starts at x=500), closer to b.
    const between = { x: 470, y: 230 };
    expect(snapTarget(between, nodes, anything)?.node.id).toBe("b");
    expect(snapTarget({ x: 420, y: 230 }, nodes, anything)?.node.id).toBe("a");
  });

  it("never returns a block the caller ruled out", () => {
    const notA = (node: { id: string }) => node.id !== "a";
    expect(snapTarget({ x: 260, y: 220 }, nodes, notA)?.node.id).not.toBe("a");
  });

  it("reports zero distance inside a block and a real one outside", () => {
    expect(snapTarget({ x: 260, y: 220 }, nodes, anything)?.distance).toBe(0);
    const near = snapTarget({ x: 200 + STEP_SIZE.w + 20, y: 230 }, nodes, anything);
    expect(near?.distance).toBeGreaterThan(0);
  });

  it("keeps the radius well inside the gap the layout leaves between columns", () => {
    // Otherwise two neighbours would both claim the same release point.
    expect(SNAP_RADIUS * 2).toBeLessThan(132);
  });
});

/**
 * Which side each output leaves from, once the targets are known.
 *
 * ANT-39. A rework edge sends work back to an earlier step, and it used to
 * leave the right edge like everything else — setting off forwards and then
 * sweeping around the block. On a workflow with several loops those sweeps
 * crossed the whole diagram.
 */
describe("ports and the direction of their work", () => {
  /**
   * Review sends work back to Implement, which sits well behind it and a row
   * higher. (Behind it in the same row, the loop runs under the row instead —
   * ANT-196, below.)
   */
  function withRework(): Workflow {
    const base = makeWorkflow();
    return {
      ...base,
      nodes: base.nodes.map((node) => (node.id === "a" ? { ...node, position: { x: 200, y: 0 } } : node)),
      edges: [...base.edges, { id: "e4", source: "b", target: "a", kind: "rework", label: "again" }],
    };
  }

  const portsOf = (workflow: Workflow, nodeId: string) =>
    buildCanvasModel(workflow).connected.filter((path) => path.nodeId === nodeId);

  it("sends a forward output out of the right edge", () => {
    const [forward] = portsOf(makeWorkflow(), "a");
    expect(forward.geometry.from.side).toBe("right");
  });

  it("sends a rework output out of the left edge, toward where it is going", () => {
    const paths = portsOf(withRework(), "b");
    const rework = paths.find((path) => path.output.kind === "rework");
    expect(rework?.geometry.from.side).toBe("left");
  });

  it("leaves the block's other outputs on the right where they belong", () => {
    const paths = portsOf(withRework(), "b");
    const onward = paths.find((path) => path.output.kind !== "rework");
    expect(onward?.geometry.from.side).toBe("right");
  });

  it("puts the rework port outside the left edge, not inside the block", () => {
    const rework = portsOf(withRework(), "b").find((path) => path.output.kind === "rework");
    const rect = blockRect(withRework().nodes.find((node) => node.id === "b")!);
    expect(rework?.geometry.from.x).toBeCloseTo(rect.left - PORT_OFFSET);
  });

  it("spaces same-side ports among themselves, not among all of them", () => {
    // One port on each side means each is centred on its own edge rather than
    // offset as though it were sharing.
    const paths = portsOf(withRework(), "b");
    const rect = blockRect(withRework().nodes.find((node) => node.id === "b")!);
    for (const path of paths) {
      expect(path.geometry.from.y).toBeCloseTo(rect.top + rect.h / 2);
    }
  });

  it("leaves an output the author placed exactly where they placed it", () => {
    // A moved port is the author's decision and outranks any of this.
    const base = withRework();
    const moved: Workflow = {
      ...base,
      edges: base.edges.map((edge) =>
        edge.id === "e4" ? { ...edge, port: { u: 1, v: 0.5 } } : edge,
      ),
    };
    const rework = portsOf(moved, "b").find((path) => path.output.kind === "rework");
    expect(rework?.geometry.from.side).toBe("right");
  });
});

/**
 * A control pill holds the name the author gave it (ANT-113).
 *
 * Start and End take any name the inspector allows, and the shape never
 * followed: "Ready for the PR" wrapped to three cramped lines inside 108×40.
 */
describe("how large a control pill is", () => {
  const pill = (name: string) =>
    blockSize({ id: "end", name, type: "end", config: {} } as WorkflowNode);

  it("leaves a short name exactly as it was", () => {
    for (const name of ["Start", "End", "Done", "Ship"]) {
      expect(pill(name), name).toEqual(PILL_SIZE);
    }
  });

  // ANT-213: "Approved" was sized a pixel short and wrapped as "Approve / d".
  it("fits a one-word name on one line with room to spare", () => {
    const approved = pill("Approved");
    expect(approved.h).toBe(PILL_SIZE.h);
    // The pill's chrome is 49px; the name gets what is left.
    expect(approved.w - 49).toBeGreaterThanOrEqual("Approved".length * 7.6 + 8);
  });

  it("grows wider for a name that does not fit", () => {
    const grown = pill("Ready for the PR");
    expect(grown.w).toBeGreaterThan(PILL_SIZE.w);
    // Wider first: one line is still enough at this length.
    expect(grown.h).toBe(PILL_SIZE.h);
  });

  it("grows taller only once it is as wide as it may get", () => {
    const long = pill("Ready for the PR once every reviewer has signed it off");
    expect(long.w).toBe(PILL_MAX.w);
    expect(long.h).toBe(PILL_MAX.h);
  });

  it("never grows past its ceiling, however long the name", () => {
    const absurd = pill("x".repeat(500));
    expect(absurd.w).toBe(PILL_MAX.w);
    expect(absurd.h).toBe(PILL_MAX.h);
  });

  it("is monotonic: a longer name is never a smaller pill", () => {
    let previous = 0;
    for (let length = 1; length <= 60; length += 1) {
      const { w } = pill("x".repeat(length));
      expect(w).toBeGreaterThanOrEqual(previous);
      previous = w;
    }
  });

  /**
   * The reason this lives in `blockSize` and not in the component: layout, the
   * canvas extent, edge anchoring and hit-testing all read it, and a pill that
   * reports one size and draws another puts the arrows in the wrong place.
   */
  it("is what blockRect measures, so an edge meets the grown pill", () => {
    const node = { id: "end", name: "Ready for the PR", type: "end", config: {} } as WorkflowNode;
    const size = blockSize(node);
    const rect = blockRect({ ...node, position: { x: 100, y: 100 } } as WorkflowNode);
    expect(rect.w).toBe(size.w);
    expect(rect.h).toBe(size.h);
  });

  it("still gives a step card its own fixed size", () => {
    const step = { id: "s", name: "A very long step name indeed", type: "agent", config: {} } as WorkflowNode;
    expect(blockSize(step)).toEqual(STEP_SIZE);
  });
});

/*
  ANT-194. A template's loop back along its row names the sides it leaves and
  arrives at — the bottom of each — and the canvas never read them, so the
  loop ran straight through the step it returns to and was hidden behind it.
*/
describe("a template's loop back along its row", () => {
  for (const id of ["multi-agent-coordination", "brainstorm-to-workflow", "consult-adversarial-decide"]) {
    it(`runs under the row, clear of every step, in ${id}`, () => {
      const template = WORKFLOW_TEMPLATES.find((item) => item.id === id);
      expect(template).toBeDefined();
      const workflow = template!.build();
      const model = buildCanvasModel(workflow);
      const loop = model.connected.find((path) => path.output.kind === "rework");
      expect(loop).toBeDefined();
      const source = model.rects.get(loop!.nodeId)!;
      const target = model.rects.get(loop!.output.target!)!;
      expect(loop!.geometry.from.y).toBeGreaterThan(source.top + source.h);
      expect(loop!.geometry.to.y).toBe(target.top + target.h);
      // And its label is not under a step.
      for (const rect of model.rects.values()) {
        const inside =
          loop!.label.x > rect.left && loop!.label.x < rect.left + rect.w &&
          loop!.label.y > rect.top && loop!.label.y < rect.top + rect.h;
        expect(inside).toBe(false);
      }
    });
  }
});

/*
  ANT-178, as the 0.8.3 QA saw it: the canvas assistant added a third branch
  under the other two. The fork's labels read against the wrong lines —
  "package B" beside the line to A — and the line to the third branch ran
  behind the second.
*/
describe("a three-way fork stacked in one column", () => {
  const step = (id: string, name: string, x: number, y: number): WorkflowNode => ({
    id,
    type: "agent",
    name,
    config: { actionKind: "agent-step" },
    position: { x, y },
  });
  const fork: Workflow = {
    id: "fork",
    name: "Fork",
    version: "1",
    nodes: [
      step("split", "Split the work", 200, 240),
      step("a", "Build area A", 440, 120),
      step("b", "Build area B", 440, 360),
      step("c", "Build area C", 440, 480),
    ],
    edges: [
      { id: "to-a", source: "split", target: "a", label: "package A" },
      { id: "to-b", source: "split", target: "b", label: "package B" },
      { id: "to-c", source: "split", target: "c", label: "package C" },
    ],
  };

  it("keeps its labels in the order of the branches they name", () => {
    const model = buildCanvasModel(fork);
    const y = (id: string) => model.connected.find((path) => path.output.id === id)!.label.y;
    expect(y("to-a")).toBeLessThan(y("to-b"));
    expect(y("to-b")).toBeLessThan(y("to-c"));
  });

  it("goes into the lowest branch from the side, not behind the one above it", () => {
    const model = buildCanvasModel(fork);
    const toC = model.connected.find((path) => path.output.id === "to-c")!;
    expect(toC.geometry.to.side).toBe("left");
    const b = model.rects.get("b")!;
    expect(toC.geometry.to.x).toBeLessThanOrEqual(b.left);
  });
});

/*
  ANT-194, found once the templates' loops left from their named sides:
  Implement, test, fix's "re-run" label was drawn under "tests failed". Each
  label was placed with no idea where the others had gone.
*/
describe("labels on a template's connections", () => {
  for (const template of WORKFLOW_TEMPLATES) {
    it(`never cover one another in ${template.id}`, () => {
      const model = buildCanvasModel(template.build());
      const boxes = model.connected
        .filter((path) => path.output.label)
        .map((path) => {
          const { halfW, halfH } = labelHalfSize(path.output.label, {
            quiet: path.output.kind === "next" && !path.output.condition,
            hasCondition: Boolean(path.output.condition),
            ...(path.output.condition ? { condition: path.output.condition } : {}),
          });
          return { id: path.output.id, x: path.label.x, y: path.label.y, halfW, halfH };
        });
      for (const a of boxes) {
        for (const b of boxes) {
          if (a.id >= b.id) continue;
          const overlap = Math.abs(a.x - b.x) < a.halfW + b.halfW && Math.abs(a.y - b.y) < a.halfH + b.halfH;
          expect(overlap, `${a.id} and ${b.id}`).toBe(false);
        }
      }
    });
  }
});

/*
  ANT-196. A workflow drafted by Codex names no sides. Its loop from Run tests
  back to Implement, the step just before it in the row, was drawn straight
  along the row, on the forward line and behind the Implement card.
*/
describe("a loop back along its row, with nothing placed by hand", () => {
  const step = (id: string, x: number): WorkflowNode => ({
    id,
    type: "agent",
    name: id,
    config: { actionKind: "agent-step" },
    position: { x, y: 44 },
  });
  const row: Workflow = {
    id: "row",
    name: "Row",
    version: "1",
    nodes: [step("implement", 286), step("test", 616), step("review", 946)],
    edges: [
      { id: "forward-1", source: "implement", target: "test" },
      { id: "forward-2", source: "test", target: "review" },
      { id: "tests-failed", source: "test", target: "implement", kind: "rework", label: "Tests failed" },
      { id: "changes", source: "review", target: "implement", kind: "rework", label: "Changes requested" },
    ],
  };
  const path = (model: ReturnType<typeof buildCanvasModel>, id: string) =>
    model.connected.find((item) => item.output.id === id)!;

  it("leaves the bottom of its step and arrives at the bottom of the one it returns to", () => {
    const model = buildCanvasModel(row);
    const loop = path(model, "tests-failed");
    expect(loop.geometry.from.side).toBe("bottom");
    expect(loop.geometry.to.side).toBe("bottom");
    expect(loop.geometry.to.y).toBe(model.rects.get("implement")!.top + model.rects.get("implement")!.h);
  });

  it("nests the longer loop under the shorter one, landing apart", () => {
    const model = buildCanvasModel(row);
    const inner = path(model, "tests-failed");
    const outer = path(model, "changes");
    expect(outer.geometry.mid.y).toBeGreaterThan(inner.geometry.mid.y);
    // The outer one lands further out, so it never crosses the inner one's run.
    expect(outer.geometry.to.x).toBeLessThan(inner.geometry.to.x);
  });

  it("keeps a port or landing that was placed by hand", () => {
    const placed: Workflow = {
      ...row,
      edges: row.edges.map((edge) => (edge.id === "tests-failed" ? { ...edge, port: { u: 0, v: 0.5 } } : edge)),
    };
    expect(path(buildCanvasModel(placed), "tests-failed").geometry.from.side).toBe("left");
  });
});

/*
  ANT-272, the 0.8.8 QA: a drafted Analyst, Writer, Reviewer row whose
  Reviewer switches between two Ends and "send back to Writer". That exit was
  left out of ANT-196's loops, so it ran from the hub straight back along the
  forward line into Writer's left side, and its label floated over the row.
*/
describe("a switcher's exit back along its row", () => {
  const handover = withDisplayLayout({
    id: "write-review",
    name: "Write and review",
    version: "1",
    target: "codex",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "analyst", type: "agent", name: "Analyst", config: {} },
      { id: "writer", type: "agent", name: "Writer", config: {} },
      { id: "reviewer", type: "agent", name: "Reviewer", config: {} },
      { id: "approved", type: "end", name: "Approved", config: {} },
      { id: "needs-attention", type: "end", name: "Needs attention", config: {} },
    ],
    edges: [
      { id: "e-start", source: "start", target: "analyst" },
      { id: "e-analyst", source: "analyst", target: "writer" },
      { id: "e-writer", source: "writer", target: "reviewer" },
      { id: "approve", source: "reviewer", target: "approved", kind: "switch", label: "Approved", condition: 'reviewer.route == "approved"' },
      { id: "rework", source: "reviewer", target: "writer", kind: "switch", label: "Review failed, send back to Writer", condition: 'reviewer.route == "rework"' },
      { id: "otherwise", source: "reviewer", target: "needs-attention", kind: "switch", label: "Otherwise" },
    ],
  } as Workflow);
  const model = buildCanvasModel(handover);
  const rework = model.connected.find((path) => path.output.id === "rework")!;
  const hub = model.switchers.find((shape) => shape.nodeId === "reviewer")!.hub;
  const writer = model.rects.get("writer")!;
  const reviewer = model.rects.get("reviewer")!;
  const rowBottom = Math.max(writer.top + writer.h, reviewer.top + reviewer.h);

  it("still leaves from the switcher's hub", () => {
    expect(rework.switcher).toBe("reviewer");
    expect(rework.geometry.from).toMatchObject({ x: hub.x, y: hub.y });
  });

  it("runs under the row and arrives at the bottom of the step it returns to", () => {
    expect(rework.geometry.to.side).toBe("bottom");
    expect(rework.geometry.to.y).toBe(writer.top + writer.h);
    const points = pathPoints(rework.geometry.path);
    // Never back along the forward line between the two steps.
    const onRow = points.filter((point) => point.x > writer.left + writer.w && point.x < reviewer.left && point.y < rowBottom);
    expect(onRow).toEqual([]);
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(rowBottom);
  });

  it("is labelled by its run under the row, not above it", () => {
    expect(rework.label.y).toBeGreaterThan(rowBottom);
    expect(rework.label.x).toBeGreaterThan(writer.left);
    expect(rework.label.x).toBeLessThan(reviewer.left + reviewer.w);
  });

  it("leaves the switcher's forward exits where they were", () => {
    for (const id of ["approve", "otherwise"]) {
      const finger = model.connected.find((path) => path.output.id === id)!;
      expect(finger.geometry.from, id).toMatchObject({ x: hub.x, y: hub.y, side: "right" });
    }
  });
});

/*
  ANT-178 again, where connections meet rather than part: Claude Code's draft
  of W9 brings "mod1–mod2 done" down and "mod3–mod5 done" up into one step.
  By their direction of travel each label went to the side facing the other
  line, so the two read crossed.
*/
describe("labels where two connections meet at one step", () => {
  const step = (id: string, x: number, y: number): WorkflowNode => ({
    id,
    type: "agent",
    name: id,
    config: { actionKind: "agent-step" },
    position: { x, y },
  });
  const join: Workflow = {
    id: "join",
    name: "Join",
    version: "1",
    nodes: [step("upper", 286, 44), step("lower", 286, 198), step("tests", 616, 132)],
    edges: [
      { id: "from-upper", source: "upper", target: "tests", label: "mod1–mod2 done" },
      { id: "from-lower", source: "lower", target: "tests", label: "mod3–mod5 done" },
    ],
  };

  it("keeps the upper line's label above the lower line's", () => {
    const model = buildCanvasModel(join);
    const y = (id: string) => model.connected.find((path) => path.output.id === id)!.label.y;
    expect(y("from-upper")).toBeLessThan(y("from-lower"));
  });
});

/*
  ANT-213, W13 through the Codex plugin in the 0.8.5 QA: a handover with no
  positions, two End blocks, and the reviewers' switchers leading to both.
  The fingers to the two ends ran along one line above the row, their labels
  floated in empty space, and "Approved" wrapped inside its own pill.
*/
describe("a handover with two ends reached through switchers", () => {
  const handover = withDisplayLayout({
    id: "notes-summary-review",
    name: "Classify notes and verify summary",
    version: "1",
    target: "codex",
    nodes: [{"id": "start", "type": "start", "name": "Start", "config": {}}, {"id": "analyst", "type": "agent", "name": "Classify notes", "config": {}}, {"id": "writer-pass-1", "type": "agent", "name": "Write SUMMARY.md", "config": {}}, {"id": "review-pass-1", "type": "agent", "name": "Review first summary", "config": {}}, {"id": "writer-pass-2", "type": "agent", "name": "Revise SUMMARY.md once", "config": {}}, {"id": "review-pass-2", "type": "agent", "name": "Review final summary", "config": {}}, {"id": "approved", "type": "end", "name": "Approved", "config": {}}, {"id": "needs-attention", "type": "end", "name": "Needs attention", "config": {}}],
    edges: [{"id": "e-start-analyst", "source": "start", "target": "analyst"}, {"id": "e-analyst-writer1", "source": "analyst", "target": "writer-pass-1"}, {"id": "e-writer1-review1", "source": "writer-pass-1", "target": "review-pass-1"}, {"id": "e-review1-approved", "source": "review-pass-1", "target": "approved", "condition": "reviewer.decision == \"approved\"", "label": "Approved", "kind": "switch"}, {"id": "e-review1-rework", "source": "review-pass-1", "target": "writer-pass-2", "condition": "reviewer.decision == \"summary_changes_requested\"", "label": "Summary corrections", "kind": "switch"}, {"id": "e-review1-failed", "source": "review-pass-1", "target": "needs-attention", "label": "Input changed or other failure", "kind": "switch"}, {"id": "e-writer2-review2", "source": "writer-pass-2", "target": "review-pass-2"}, {"id": "e-review2-approved", "source": "review-pass-2", "target": "approved", "condition": "reviewer.decision == \"approved\"", "label": "Approved", "kind": "switch"}, {"id": "e-review2-failed", "source": "review-pass-2", "target": "needs-attention", "label": "Still incorrect", "kind": "switch"}],
  } as Workflow);
  const model = buildCanvasModel(handover);
  const finger = (id: string) => model.connected.find((path) => path.output.id === id)!;

  it("runs each finger past the row in a lane of its own", () => {
    const lanes = model.connected.flatMap((path) => (path.geometry.lane ? [path.geometry.lane] : []));
    expect(lanes.length).toBeGreaterThan(1);
    for (const [i, a] of lanes.entries()) {
      for (const b of lanes.slice(i + 1)) {
        const overlap = a.left < b.right && b.left < a.right && a.up === b.up;
        if (overlap) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it("puts a finger's label on its own lane", () => {
    for (const id of ["e-review1-approved", "e-review1-failed"]) {
      const path = finger(id);
      expect(path.geometry.lane, id).toBeDefined();
      if (!path.geometry.lane) continue;
      expect(path.label.y, id).toBe(path.geometry.lane.y);
      expect(path.label.x, id).toBeGreaterThanOrEqual(path.geometry.lane.left);
      expect(path.label.x, id).toBeLessThanOrEqual(path.geometry.lane.right);
    }
  });

  it("keeps a level finger's label off the other fingers' lanes", () => {
    const short = finger("e-review1-rework");
    const lanes = model.connected.flatMap((path) => (path.geometry.lane ? [path.geometry.lane] : []));
    const crosses = lanes.some(
      (lane) =>
        lane.left <= short.label.x &&
        short.label.x <= lane.right &&
        Math.min(short.label.y, short.geometry.mid.y) < lane.y &&
        lane.y < Math.max(short.label.y, short.geometry.mid.y),
    );
    expect(crosses).toBe(false);
  });
});

/*
  ANT-239, re-testing ANT-213 on W29: the same handover shape, but the last
  switcher's ends sit just past its hub, one a little above it and one a
  little below. Its fingers landed on the upper End's bottom and the lower
  End's top, each swung the wrong way first and they crossed, and each label
  sat by the other line: "Second rejection" on the drop of "Test failure after
  retry", "Approved" under the lower End.
*/
describe("a switcher whose fingers both end just past its hub", () => {
  const handover = withDisplayLayout(
    JSON.parse(readFileSync("src/__fixtures__/w29-two-ends.workflow.json", "utf8")) as Workflow,
  );
  const model = buildCanvasModel(handover);
  const finger = (id: string) => model.connected.find((path) => path.output.id === id)!;
  const hub = model.switchers.find((shape) => shape.nodeId === "reviewer-retry")!.hub;

  it("fans out without crossing: up to the upper End, down to the lower", () => {
    // The fixture's shape: Approved above the hub, Needs attention below it.
    expect(model.rects.get("approved")!.top).toBeLessThan(hub.y);
    expect(model.rects.get("needs-attention")!.top + model.rects.get("needs-attention")!.h).toBeGreaterThan(hub.y);

    const up = pathPoints(finger("retry-review-approved").geometry.path);
    const down = pathPoints(finger("retry-review-rejected").geometry.path);
    expect(Math.max(...up.map((point) => point.y))).toBeLessThanOrEqual(hub.y + 0.5);
    expect(Math.min(...down.map((point) => point.y))).toBeGreaterThanOrEqual(hub.y - 0.5);
  });

  it("puts each finger's label by its own finger, near the hub", () => {
    for (const id of ["retry-review-approved", "retry-review-rejected"]) {
      const own = finger(id);
      const mine = distanceTo(own.label, pathPoints(own.geometry.path));
      for (const other of model.connected) {
        if (other === own) continue;
        expect(mine, `${id} vs ${other.output.id}`).toBeLessThan(distanceTo(own.label, pathPoints(other.geometry.path)));
      }
      // Along its own finger, between the hub and the End it lands on. Since
      // the gap after a switcher fits its labels (ANT-250), the finger is
      // longer than the 120px from the hub this used to be measured against.
      const points = pathPoints(own.geometry.path);
      const end = points[points.length - 1];
      expect(own.label.x, id).toBeGreaterThan(hub.x);
      expect(own.label.x, id).toBeLessThan(end.x);
    }
  });

  it("keeps those labels off every other line", () => {
    for (const id of ["retry-review-approved", "retry-review-rejected"]) {
      const own = finger(id);
      const { halfW, halfH } = labelHalfSize(own.output.label ?? " ");
      for (const other of model.connected) {
        if (other === own) continue;
        const through = pathPoints(other.geometry.path).some(
          (point) => Math.abs(point.x - own.label.x) < halfW && Math.abs(point.y - own.label.y) < halfH,
        );
        expect(through, `${id} sits on ${other.output.id}`).toBe(false);
      }
    }
  });
});

/*
  ANT-250, the 0.8.6 QA: on two handovers laid out by Anthill (no positions),
  the labels of switcher fingers that did not fit between the hub and the next
  step went wherever there was room — "Final review approved" onto the lane of
  "Otherwise: retry tests failed", "Otherwise: report unresolved issues" high
  above the row. The gap after a switcher now fits its widest label.
*/
describe("switcher labels on handovers Anthill laid out itself", () => {
  for (const file of ["ant250-two-ends-retry", "ant250-notes-review"]) {
    const model = buildCanvasModel(
      withDisplayLayout(JSON.parse(readFileSync(`src/__fixtures__/${file}.workflow.json`, "utf8")) as Workflow),
    );
    const fingers = model.connected.filter((path) => path.switcher);

    it(`${file}: every finger's label is nearer its own line than any other`, () => {
      expect(fingers.length).toBeGreaterThan(0);
      for (const own of fingers) {
        if (own.geometry.lane) continue;
        const mine = distanceTo(own.label, pathPoints(own.geometry.path));
        for (const other of model.connected) {
          if (other === own) continue;
          // A tie is two fingers still side by side as they leave one hub.
          expect(mine, `${own.output.id} vs ${other.output.id}`).toBeLessThanOrEqual(
            distanceTo(own.label, pathPoints(other.geometry.path)),
          );
        }
      }
    });

    it(`${file}: no finger's label sits on another line`, () => {
      for (const own of fingers) {
        const { halfW, halfH } = labelHalfSize(own.output.label ?? " ");
        for (const other of model.connected) {
          if (other === own) continue;
          const through = pathPoints(other.geometry.path).some(
            (point) => Math.abs(point.x - own.label.x) < halfW && Math.abs(point.y - own.label.y) < halfH,
          );
          expect(through, `${own.output.id} sits on ${other.output.id}`).toBe(false);
        }
      }
    });
  }
});

/*
  ANT-254, the 0.8.6 QA, M8: a first review's "passed" to the upper of two stacked Ends
  was sent round over the row and still landed on that End's bottom, so the
  line dropped through the End and its arrow pointed up from underneath.
*/
describe("a line sent round over the row to a block above its port", () => {
  const model = buildCanvasModel(
    withDisplayLayout(JSON.parse(readFileSync("src/__fixtures__/two-ends-lane-over.workflow.json", "utf8")) as Workflow),
  );
  const over = model.connected.find((path) => path.output.id === "review-1-done");

  it("goes over the top and lands on the End's side, not its bottom", () => {
    expect(over?.geometry.lane?.up).toBe(true);
    expect((over?.geometry.to as { side?: string } | undefined)?.side).toBe("left");
  });

  it("never passes through the End it lands on", () => {
    const done = model.rects.get("done");
    expect(done).toBeDefined();
    const inside = pathPoints(over!.geometry.path).filter(
      (point) =>
        point.x > done!.left + 1 &&
        point.x < done!.left + done!.w - 1 &&
        point.y > done!.top + 1 &&
        point.y < done!.top + done!.h - 1,
    );
    expect(inside).toEqual([]);
  });
});

/** Points along a drawn path — its M, L, Q and C commands — close enough to measure against. */
function pathPoints(path: string): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const commands = path.match(/[MLQC][^MLQC]*/g) ?? [];
  let at = { x: 0, y: 0 };
  for (const command of commands) {
    const numbers = (command.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const pairs: { x: number; y: number }[] = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) pairs.push({ x: numbers[index], y: numbers[index + 1] });
    const end = pairs[pairs.length - 1];
    for (let step = 0; step <= 32; step += 1) {
      const t = step / 32;
      const m = 1 - t;
      if (command[0] === "M") break;
      if (command[0] === "L") points.push({ x: at.x + (end.x - at.x) * t, y: at.y + (end.y - at.y) * t });
      if (command[0] === "Q") {
        const [c] = pairs;
        points.push({ x: m * m * at.x + 2 * m * t * c.x + t * t * end.x, y: m * m * at.y + 2 * m * t * c.y + t * t * end.y });
      }
      if (command[0] === "C") {
        const [c1, c2] = pairs;
        points.push({
          x: m * m * m * at.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * end.x,
          y: m * m * m * at.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * end.y,
        });
      }
    }
    if (command[0] === "M") points.push(end);
    at = end;
  }
  return points;
}

function distanceTo(point: { x: number; y: number }, points: readonly { x: number; y: number }[]): number {
  return Math.min(...points.map((other) => Math.hypot(other.x - point.x, other.y - point.y)));
}
