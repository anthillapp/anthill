/**
 * Where the preview's connections land.
 *
 * ANT-10. The blocks were HTML elements in CSS pixels and the edges were path
 * data typed by hand, and the two drifted: one connection stopped 34px past
 * the block it pointed at, two others ended in open space above and below
 * blocks, and none had an arrowhead. Those are not judgement calls — they are
 * arithmetic, and arithmetic can be checked.
 *
 * So these tests assert the one property that failing produced every symptom
 * in the report: an edge touches the blocks it names, on the side it names,
 * exactly in the middle, and it does so before anyone looks at it.
 */

import { describe, expect, it } from "vitest";

import {
  PREVIEW_EDGES,
  PREVIEW_NODES,
  PREVIEW_SIZE,
  port,
  previewEnds,
  previewPath,
  type PreviewNode,
} from "./draft-preview.js";

const byId = new Map(PREVIEW_NODES.map((node) => [node.id, node]));

/** The first and last coordinate pair of a cubic path. */
function endpoints(d: string) {
  const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  expect(numbers).toHaveLength(8);
  return {
    from: { x: numbers[0], y: numbers[1] },
    to: { x: numbers[6], y: numbers[7] },
  };
}

function overlaps(a: PreviewNode, b: PreviewNode): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("the blocks", () => {
  it("do not overlap each other", () => {
    for (const a of PREVIEW_NODES) {
      for (const b of PREVIEW_NODES) {
        if (a.id !== b.id) expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it("stay inside the frame", () => {
    for (const node of PREVIEW_NODES) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.w).toBeLessThanOrEqual(PREVIEW_SIZE.width);
      expect(node.y + node.h).toBeLessThanOrEqual(PREVIEW_SIZE.height);
    }
  });
});

describe("the connections", () => {
  it("name blocks that exist", () => {
    for (const edge of PREVIEW_EDGES) {
      expect(byId.has(edge.from)).toBe(true);
      expect(byId.has(edge.to)).toBe(true);
    }
  });

  it("begin and end exactly on a port, never near one", () => {
    for (const edge of PREVIEW_EDGES) {
      const drawn = endpoints(previewPath(edge));
      const ends = previewEnds(edge);
      expect(drawn.from).toEqual(ends.from);
      expect(drawn.to).toEqual(ends.to);
      expect(ends.from).toEqual(port(byId.get(edge.from) as PreviewNode, edge.fromSide));
      expect(ends.to).toEqual(port(byId.get(edge.to) as PreviewNode, edge.toSide));
    }
  });

  it("touch the edge of the block they name, in the middle of that side", () => {
    // The old failure, stated as a property: an endpoint must sit on a block's
    // boundary — not inside it, not in the space beside it.
    for (const edge of PREVIEW_EDGES) {
      const ends = previewEnds(edge);
      for (const [id, point] of [
        [edge.from, ends.from],
        [edge.to, ends.to],
      ] as const) {
        const node = byId.get(id) as PreviewNode;
        const onVerticalSide = point.x === node.x || point.x === node.x + node.w;
        const onHorizontalSide = point.y === node.y || point.y === node.y + node.h;
        expect(onVerticalSide || onHorizontalSide).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(node.x);
        expect(point.x).toBeLessThanOrEqual(node.x + node.w);
        expect(point.y).toBeGreaterThanOrEqual(node.y);
        expect(point.y).toBeLessThanOrEqual(node.y + node.h);
        if (onVerticalSide && !onHorizontalSide) expect(point.y).toBe(node.y + node.h / 2);
        if (onHorizontalSide && !onVerticalSide) expect(point.x).toBe(node.x + node.w / 2);
      }
    }
  });

  it("do not end inside a block they are not attached to", () => {
    for (const edge of PREVIEW_EDGES) {
      const { to } = previewEnds(edge);
      for (const node of PREVIEW_NODES) {
        if (node.id === edge.to || node.id === edge.from) continue;
        const inside =
          to.x > node.x && to.x < node.x + node.w && to.y > node.y && to.y < node.y + node.h;
        expect(inside).toBe(false);
      }
    }
  });

  it("appear only after the block they point at", () => {
    // A connection drawn to a block that has not been revealed yet is the same
    // dangling fragment, reached through time rather than through space.
    for (const edge of PREVIEW_EDGES) {
      const target = byId.get(edge.to) as PreviewNode;
      const source = byId.get(edge.from) as PreviewNode;
      expect(edge.delay).toBeGreaterThanOrEqual(target.delay);
      expect(edge.delay).toBeGreaterThanOrEqual(source.delay);
    }
  });

  it("leave and arrive square to the block, so the arrowhead points the right way", () => {
    for (const edge of PREVIEW_EDGES) {
      const numbers = (previewPath(edge).match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const [x0, y0, cx1, cy1, cx2, cy2, x1, y1] = numbers;
      // The first handle sits along the source side's normal, the second along
      // the target's — one of the two coordinates is unchanged in each case.
      expect(cx1 === x0 || cy1 === y0).toBe(true);
      expect(cx2 === x1 || cy2 === y1).toBe(true);
      // And a handle never doubles back through the block it left.
      expect({ x: cx1, y: cy1 }).not.toEqual({ x: x0, y: y0 });
      expect({ x: cx2, y: cy2 }).not.toEqual({ x: x1, y: y1 });
    }
  });

  it("give the rework return more room than a step across", () => {
    // It has to get out from under the block it leaves and travel back across
    // the diagram; the same short handle produced a kink.
    const rework = PREVIEW_EDGES.find((edge) => edge.tone === "rework");
    const next = PREVIEW_EDGES.find((edge) => edge.tone === "next");
    const reach = (d: string) => {
      const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      return Math.abs(n[2] - n[0]) + Math.abs(n[3] - n[1]);
    };
    expect(reach(previewPath(rework!))).toBeGreaterThan(reach(previewPath(next!)));
  });
});

describe("a port", () => {
  const node: PreviewNode = { id: "n1", x: 10, y: 20, w: 100, h: 40, tone: "plain", delay: 0 };

  it("is the middle of the side it names", () => {
    expect(port(node, "left")).toEqual({ x: 10, y: 40 });
    expect(port(node, "right")).toEqual({ x: 110, y: 40 });
    expect(port(node, "top")).toEqual({ x: 60, y: 20 });
    expect(port(node, "bottom")).toEqual({ x: 60, y: 60 });
  });
});
