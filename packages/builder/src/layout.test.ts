import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@anthill/workflow-schema";

import {
  clearerSide,
  countCrossings,
  layoutWorkflow,
  splitBackEdges,
  withLayout,
} from "./layout";
import { PILL_SIZE, STEP_SIZE, blockRect, buildCanvasModel } from "./workflow-canvas-model";

const step = (id: string): WorkflowNode => ({ id, type: "agent", name: id, config: {} });
const pill = (id: string, type: "start" | "end"): WorkflowNode => ({ id, type, name: id, config: {} });
const edge = (id: string, source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source,
  target,
  ...extra,
});

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "Workflow", version: "1", nodes, edges };
}

/** Start → a → b → End, the plainest workflow there is. */
const chain = () =>
  makeWorkflow(
    [pill("s", "start"), step("a"), step("b"), pill("e", "end")],
    [edge("1", "s", "a"), edge("2", "a", "b"), edge("3", "b", "e")],
  );

describe("splitBackEdges", () => {
  it("finds nothing to break in an acyclic workflow", () => {
    const { forward, back } = splitBackEdges(
      ["s", "a", "b"],
      [{ from: "s", to: "a" }, { from: "a", to: "b" }],
    );
    expect(back).toEqual([]);
    expect(forward).toHaveLength(2);
  });

  it("breaks the edge that returns, not the one that goes on", () => {
    const { forward, back } = splitBackEdges(
      ["s", "a", "b"],
      [{ from: "s", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    expect(back).toEqual([{ from: "b", to: "a" }]);
    expect(forward).toHaveLength(2);
  });

  it("breaks one edge per loop, not the whole loop", () => {
    const { back } = splitBackEdges(
      ["a", "b", "c"],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    );
    expect(back).toHaveLength(1);
  });

  it("reaches a component nothing points into", () => {
    const { back } = splitBackEdges(
      ["a", "b", "x", "y"],
      [{ from: "a", to: "b" }, { from: "x", to: "y" }, { from: "y", to: "x" }],
    );
    // The orphaned pair loops among itself and must still be broken.
    expect(back).toHaveLength(1);
  });
});

describe("columns", () => {
  it("puts a chain in one column each, left to right", () => {
    const positions = layoutWorkflow(chain());
    const xs = ["s", "a", "b", "e"].map((id) => positions.get(id)!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
  });

  it("keeps a chain on one line rather than stepping down the page", () => {
    const positions = layoutWorkflow(chain());
    const centre = (id: string, height: number) => positions.get(id)!.y + height / 2;
    expect(centre("a", STEP_SIZE.h)).toBeCloseTo(centre("b", STEP_SIZE.h), 0);
    // A pill is shorter than a step, so its centre is what should line up.
    expect(Math.abs(centre("s", PILL_SIZE.h) - centre("a", STEP_SIZE.h))).toBeLessThan(22);
  });

  it("waits for everything that feeds a block before placing it", () => {
    // s → a → c and s → b → c: c must sit right of both, not next to a.
    const positions = layoutWorkflow(
      makeWorkflow(
        [pill("s", "start"), step("a"), step("b"), step("c")],
        [edge("1", "s", "a"), edge("2", "s", "b"), edge("3", "a", "c"), edge("4", "b", "c")],
      ),
    );
    expect(positions.get("c")!.x).toBeGreaterThan(positions.get("a")!.x);
    expect(positions.get("c")!.x).toBeGreaterThan(positions.get("b")!.x);
  });

  it("puts the two halves of a branch in one column, apart", () => {
    const positions = layoutWorkflow(
      makeWorkflow(
        [pill("s", "start"), step("a"), step("b")],
        [edge("1", "s", "a"), edge("2", "s", "b")],
      ),
    );
    expect(positions.get("a")!.x).toBe(positions.get("b")!.x);
    expect(positions.get("a")!.y).not.toBe(positions.get("b")!.y);
  });

  it("does not let a loop drag its target into a later column", () => {
    // a → b → a. Without breaking the back edge, neither could be placed.
    const positions = layoutWorkflow(
      makeWorkflow(
        [pill("s", "start"), step("a"), step("b")],
        [edge("1", "s", "a"), edge("2", "a", "b"), edge("3", "b", "a", { kind: "rework" })],
      ),
    );
    expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
  });
});

describe("spacing", () => {
  it("never overlaps two blocks", () => {
    const workflow = withLayout(
      makeWorkflow(
        [
          pill("s", "start"),
          step("a"),
          step("b"),
          step("c"),
          step("d"),
          pill("e", "end"),
        ],
        [
          edge("1", "s", "a"),
          edge("2", "a", "b"),
          edge("3", "a", "c"),
          edge("4", "b", "d"),
          edge("5", "c", "d"),
          edge("6", "d", "e"),
          edge("7", "d", "a", { kind: "rework" }),
        ],
      ),
    );

    const rects = workflow.nodes.map((node) => blockRect(node));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const overlaps =
          a.left < b.left + b.w &&
          a.left + a.w > b.left &&
          a.top < b.top + b.h &&
          a.top + a.h > b.top;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("leaves room between columns for a label to sit on the line", () => {
    const positions = layoutWorkflow(chain());
    const gap = positions.get("b")!.x - (positions.get("a")!.x + STEP_SIZE.w);
    expect(gap).toBeGreaterThanOrEqual(110);
  });

  it("leaves room between stacked blocks for their ports", () => {
    // Ports spread 22px apart around a block's edge; a tight stack would put
    // one block's ports on top of the next one.
    const positions = layoutWorkflow(
      makeWorkflow(
        [pill("s", "start"), step("a"), step("b")],
        [edge("1", "s", "a"), edge("2", "s", "b")],
      ),
    );
    const gap = Math.abs(positions.get("b")!.y - positions.get("a")!.y) - STEP_SIZE.h;
    expect(gap).toBeGreaterThanOrEqual(44);
  });

  it("snaps to the grid the canvas draws", () => {
    for (const position of layoutWorkflow(chain()).values()) {
      expect(position.x % 22).toBe(0);
      expect(position.y % 22).toBe(0);
    }
  });

  it("starts at a positive origin, so nothing sits off the canvas", () => {
    for (const position of layoutWorkflow(chain()).values()) {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("crossings", () => {
  it("reduces them against the order the blocks happen to be listed in", () => {
    // Two independent lanes, declared interleaved so the naive order weaves
    // them together. Ordering should separate them.
    const nodes = [
      pill("s", "start"),
      step("a1"),
      step("b1"),
      step("a2"),
      step("b2"),
      pill("e", "end"),
    ];
    const edges = [
      edge("1", "s", "a1"),
      edge("2", "s", "b1"),
      edge("3", "a1", "a2"),
      edge("4", "b1", "b2"),
      edge("5", "a2", "e"),
      edge("6", "b2", "e"),
    ];

    const laid = withLayout(makeWorkflow(nodes, edges));
    const naive = withLayout(makeWorkflow(nodes, edges), { sweeps: 0 });
    expect(countCrossings(laid)).toBeLessThanOrEqual(countCrossings(naive));
    expect(countCrossings(laid)).toBe(0);
  });

  it("keeps a plain chain free of them", () => {
    expect(countCrossings(withLayout(chain()))).toBe(0);
  });

  it("still produces a readable layout for a tangled cyclic graph", () => {
    // No claim that this is optimal — only that every block is placed, on the
    // grid, without overlapping, which is the fallback promise.
    const ids = ["a", "b", "c", "d", "e", "f"];
    const nodes = [pill("s", "start"), ...ids.map(step)];
    const edges: WorkflowEdge[] = [edge("in", "s", "a")];
    ids.forEach((from, index) => {
      for (const to of ids) {
        if (from !== to && (index % 2 === 0 || to === "a")) {
          edges.push(edge(`${from}-${to}`, from, to));
        }
      }
    });

    const laid = withLayout(makeWorkflow(nodes, edges));
    expect(laid.nodes.every((node) => node.position !== undefined)).toBe(true);
    expect(new Set(laid.nodes.map((node) => JSON.stringify(node.position))).size).toBe(
      laid.nodes.length,
    );
  });
});

describe("withLayout", () => {
  it("returns an empty workflow untouched", () => {
    const empty = makeWorkflow([], []);
    expect(withLayout(empty)).toBe(empty);
  });

  it("places a block nothing connects to rather than leaving it at the origin", () => {
    const laid = withLayout(
      makeWorkflow([pill("s", "start"), step("a"), step("orphan")], [edge("1", "s", "a")]),
    );
    expect(laid.nodes.find((node) => node.id === "orphan")?.position).toBeDefined();
  });

  it("ignores an edge pointing at a block that is not there", () => {
    const laid = withLayout(
      makeWorkflow([pill("s", "start"), step("a")], [edge("1", "s", "a"), edge("2", "a", "ghost")]),
    );
    expect(laid.nodes).toHaveLength(2);
  });

  it("replaces whatever positions were there, since it is only used on a new workflow", () => {
    const stale = makeWorkflow([pill("s", "start"), step("a")], [edge("1", "s", "a")]);
    stale.nodes[1].position = { x: 9999, y: 9999 };
    expect(withLayout(stale).nodes[1].position).not.toEqual({ x: 9999, y: 9999 });
  });
});

describe("loops arched over the flow", () => {
  /** Start → a → b → c → End, with c sending work back to a. */
  const looping = () =>
    makeWorkflow(
      [pill("s", "start"), step("a"), step("b"), step("c"), pill("e", "end")],
      [
        edge("1", "s", "a"),
        edge("2", "a", "b"),
        edge("3", "b", "c"),
        edge("4", "c", "e"),
        edge("5", "c", "a", { kind: "rework", label: "failed" }),
      ],
    );

  const routed = (workflow: Workflow, id: string) =>
    withLayout(workflow).edges.find((item) => item.id === id) as WorkflowEdge;

  it("gives the loop a shape of its own", () => {
    const back = routed(looping(), "5");
    expect(back.bend).toBeDefined();
    expect(back.anchor).toBeDefined();
  });

  it("lands it on top of its target rather than sliding into the side", () => {
    // Coming in from the left means passing through everything in between.
    expect(routed(looping(), "5").anchor?.v).toBe(0);
  });

  it("takes the arc clear of every block it passes over", () => {
    const laid = withLayout(looping());
    const model = buildCanvasModel(laid);
    const back = model.connected.find((path) => path.output.id === "5");
    const highest = Math.min(...laid.nodes.map((node) => node.position?.y ?? 0));

    // The middle of the line is where it would otherwise sit behind a block.
    expect(back?.geometry.mid.y).toBeLessThan(highest);
  });

  it("keeps its label off the blocks too, since the label follows the line", () => {
    const model = buildCanvasModel(withLayout(looping()));
    const back = model.connected.find((path) => path.output.id === "5");
    const blocks = [...model.rects.values()];
    const onABlock = blocks.some(
      (rect) =>
        (back?.label.y ?? 0) > rect.top && (back?.label.y ?? 0) < rect.top + rect.h,
    );
    expect(onABlock).toBe(false);
  });

  it("leaves every forward connection alone", () => {
    const laid = withLayout(looping());
    for (const id of ["1", "2", "3", "4"]) {
      const forward = laid.edges.find((item) => item.id === id) as WorkflowEdge;
      expect(forward.bend).toBeUndefined();
      expect(forward.anchor).toBeUndefined();
    }
  });

  it("nests a longer loop above a shorter one", () => {
    const workflow = makeWorkflow(
      [pill("s", "start"), step("a"), step("b"), step("c"), step("d")],
      [
        edge("1", "s", "a"),
        edge("2", "a", "b"),
        edge("3", "b", "c"),
        edge("4", "c", "d"),
        edge("short", "c", "b", { kind: "rework" }),
        edge("long", "d", "a", { kind: "rework" }),
      ],
    );
    const model = buildCanvasModel(withLayout(workflow));
    const short = model.connected.find((path) => path.output.id === "short");
    const long = model.connected.find((path) => path.output.id === "long");
    // Higher on screen is a smaller y.
    expect(long?.geometry.mid.y).toBeLessThan(short?.geometry.mid.y ?? 0);
  });

  it("spreads two loops that land on the same block", () => {
    const workflow = makeWorkflow(
      [pill("s", "start"), step("a"), step("b"), step("c")],
      [
        edge("1", "s", "a"),
        edge("2", "a", "b"),
        edge("3", "b", "c"),
        edge("x", "b", "a", { kind: "rework" }),
        edge("y", "c", "a", { kind: "rework" }),
      ],
    );
    const laid = withLayout(workflow);
    const first = laid.edges.find((item) => item.id === "x")?.anchor;
    const second = laid.edges.find((item) => item.id === "y")?.anchor;
    expect(first?.u).not.toBe(second?.u);
  });

  it("ignores an edge from a block to itself", () => {
    const workflow = makeWorkflow(
      [pill("s", "start"), step("a")],
      [edge("1", "s", "a"), edge("self", "a", "a")],
    );
    expect(withLayout(workflow).edges.find((item) => item.id === "self")?.bend).toBeUndefined();
  });

  it("leaves the loop draggable like any other line", () => {
    // Stored as an ordinary anchor and bend, so the canvas handles work on it.
    const back = routed(looping(), "5");
    expect(typeof back.bend?.along).toBe("number");
    expect(typeof back.bend?.across).toBe("number");
  });
});

describe("where a rework connection leaves its block", () => {
  const routed = (workflow: Workflow, id: string) =>
    withLayout(workflow).edges.find((item) => item.id === id) as WorkflowEdge;

  /** Start → a → b → c → d, with `back` returning from d to `to`. */
  const chainWithLoop = (to: string) =>
    makeWorkflow(
      [pill("s", "start"), step("a"), step("b"), step("c"), step("d")],
      [
        edge("1", "s", "a"),
        edge("2", "a", "b"),
        edge("3", "b", "c"),
        edge("4", "c", "d"),
        edge("back", "d", to, { kind: "rework", label: "failed" }),
      ],
    );

  it("never leaves from the right, which is where the flow goes", () => {
    for (const target of ["a", "c"]) {
      const port = routed(chainWithLoop(target), "back").port;
      expect(port).toBeDefined();
      expect(port?.u).toBeLessThan(1);
    }
  });

  it("goes back one step out of the left side, into the right of its neighbour", () => {
    const back = routed(chainWithLoop("c"), "back");
    expect(back.port?.u).toBe(0);
    expect(back.anchor?.u).toBe(1);
  });

  it("keeps a one-step return out of the forward arrow's way", () => {
    // Both share the gap between the two blocks, so the return sits lower.
    const back = routed(chainWithLoop("c"), "back");
    expect(back.port?.v).toBeGreaterThan(0.5);
    expect(back.anchor?.v).toBeGreaterThan(0.5);
  });

  it("draws a one-step return without an arc, since there is nothing to clear", () => {
    expect(routed(chainWithLoop("c"), "back").bend).toBeUndefined();
  });

  it("leaves from the top when it reaches further back than one step", () => {
    const back = routed(chainWithLoop("a"), "back");
    expect(back.port?.v).toBe(0);
    expect(back.anchor?.v).toBe(0);
  });

  it("arches a longer return clear of the blocks it passes over", () => {
    const laid = withLayout(chainWithLoop("a"));
    const model = buildCanvasModel(laid);
    const back = model.connected.find((path) => path.output.id === "back");
    const highest = Math.min(...laid.nodes.map((node) => node.position?.y ?? 0));
    expect(back?.geometry.mid.y).toBeLessThan(highest);
  });

  it("prefers the top when neither side is crowded", () => {
    expect(routed(chainWithLoop("a"), "back").anchor?.v).toBe(0);
  });

  it("spreads two long returns that leave the same block", () => {
    const workflow = makeWorkflow(
      [pill("s", "start"), step("a"), step("b"), step("c"), step("d")],
      [
        edge("1", "s", "a"),
        edge("2", "a", "b"),
        edge("3", "b", "c"),
        edge("4", "c", "d"),
        edge("p", "d", "a", { kind: "rework" }),
        edge("q", "d", "b", { kind: "rework" }),
      ],
    );
    const laid = withLayout(workflow);
    const first = laid.edges.find((item) => item.id === "p")?.port;
    const second = laid.edges.find((item) => item.id === "q")?.port;
    expect(first?.u).not.toBe(second?.u);
  });

  it("leaves the forward connections without ports of their own", () => {
    const laid = withLayout(chainWithLoop("a"));
    for (const id of ["1", "2", "3", "4"]) {
      expect(laid.edges.find((item) => item.id === id)?.port).toBeUndefined();
    }
  });
});

describe("clearerSide", () => {
  const rect = (left: number, top: number) => ({ left, top, w: 196, h: 100 });
  const span = { left: 0, right: 800 };

  /** The band is the loop's own two blocks, both sitting on the row at y=400. */
  const band = { top: 400, bottom: 500 };

  it("goes over when nothing is above and nothing is below", () => {
    expect(clearerSide([rect(0, 400), rect(300, 400)], span, band)).toBe("top");
  });

  it("goes under when the space above is the busy one", () => {
    const rects = [rect(0, 400), rect(100, 100), rect(400, 100), rect(600, 100)];
    expect(clearerSide(rects, span, band)).toBe("bottom");
  });

  it("goes over when the space below is the busy one", () => {
    const rects = [rect(0, 400), rect(100, 700), rect(400, 700), rect(600, 700)];
    expect(clearerSide(rects, span, band)).toBe("top");
  });

  it("only counts blocks the loop would actually pass over", () => {
    // Above the band, but far to the right of where this loop travels.
    const rects = [rect(0, 400), rect(3000, 100), rect(3300, 100)];
    expect(clearerSide(rects, span, band)).toBe("top");
  });

  it("counts a block level with the band as neither above nor below it", () => {
    expect(clearerSide([rect(0, 400), rect(300, 400)], span, band)).toBe("top");
  });
});
