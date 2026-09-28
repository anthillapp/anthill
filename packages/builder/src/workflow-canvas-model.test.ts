import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { WORKFLOW_TEMPLATES, addOutput } from "@anthill/workflow";

import { PORT_OFFSET, labelHalfSize } from "./geometry";
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
  /** Review sends work back to Implement, which sits well behind it. */
  function withRework(): Workflow {
    const base = makeWorkflow();
    return {
      ...base,
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
