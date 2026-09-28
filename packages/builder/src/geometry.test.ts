import { describe, expect, it } from "vitest";

import {
  ELBOW_STUB,
  PORT_OFFSET,
  PORT_SPACING,
  anchorFromPoint,
  bendFromPoint,
  curve,
  elbow,
  entryPoint,
  labelHalfSize,
  labelSpot,
  outward,
  portFromAnchor,
  portPoint,
  portSideToward,
  route,
  unconnectedStub,
  type Rect,
} from "./geometry";

/** A step card, the size used throughout the design. */
const block = (left: number, top: number): Rect => ({ left, top, w: 196, h: 100 });

describe("portPoint", () => {
  it("puts a single port just outside the right edge, vertically centred", () => {
    expect(portPoint(block(0, 0), 0, 1)).toEqual({
      x: 196 + PORT_OFFSET,
      y: 50,
      side: "right",
    });
  });

  it("keeps the port clear of the card rather than on its border", () => {
    const rect = block(0, 0);
    // Half-overlapping the edge, a port reads as part of the border instead of
    // something to grab.
    expect(portPoint(rect, 0, 1).x).toBeGreaterThan(rect.left + rect.w);
  });

  it("spaces several ports evenly around the centre", () => {
    const rect = block(0, 0);
    expect(portPoint(rect, 0, 2).y).toBe(50 - PORT_SPACING / 2);
    expect(portPoint(rect, 1, 2).y).toBe(50 + PORT_SPACING / 2);
  });

  it("keeps the middle port centred when there is an odd number", () => {
    expect(portPoint(block(0, 0), 1, 3).y).toBe(50);
  });

  it("follows the block when it moves", () => {
    expect(portPoint(block(100, 40), 0, 1)).toEqual({
      x: 296 + PORT_OFFSET,
      y: 90,
      side: "right",
    });
  });
});

describe("entryPoint – with an anchor", () => {
  const rect = block(100, 100);

  it("lands on the side nearest the anchored point", () => {
    expect(entryPoint(rect, { x: 0, y: 0 }, { u: 0.02, v: 0.5 }).side).toBe("left");
    expect(entryPoint(rect, { x: 0, y: 0 }, { u: 0.98, v: 0.5 }).side).toBe("right");
    expect(entryPoint(rect, { x: 0, y: 0 }, { u: 0.5, v: 0.02 }).side).toBe("top");
    expect(entryPoint(rect, { x: 0, y: 0 }, { u: 0.5, v: 0.98 }).side).toBe("bottom");
  });

  it("lands where it was pointed, not at the middle of the side", () => {
    const point = entryPoint(rect, { x: 0, y: 0 }, { u: 0, v: 0.3 });
    expect(point).toMatchObject({ x: 100, side: "left" });
    expect(point.y).toBe(130);
    expect(point.y).not.toBe(rect.top + rect.h / 2);
  });

  it("keeps the landing off the corners", () => {
    const top = entryPoint(rect, { x: 0, y: 0 }, { u: 0, v: 0 });
    // A corner anchor would otherwise put the arrowhead exactly on the corner.
    expect(top.y).toBeGreaterThanOrEqual(rect.top + 12);

    const along = entryPoint(rect, { x: 0, y: 0 }, { u: 0, v: 0.01 });
    expect(along.y).toBeGreaterThanOrEqual(rect.top + 12);
  });

  it("clamps an anchor that falls outside the block", () => {
    const point = entryPoint(rect, { x: 0, y: 0 }, { u: -3, v: 4 });
    expect(point.x).toBeGreaterThanOrEqual(rect.left);
    expect(point.y).toBeLessThanOrEqual(rect.top + rect.h);
  });
});

describe("entryPoint – without an anchor", () => {
  const rect = block(100, 100);

  it("comes in at the top when the source is well above", () => {
    expect(entryPoint(rect, { x: 150, y: 10 }).side).toBe("top");
  });

  it("comes in at the bottom when the source is well below", () => {
    expect(entryPoint(rect, { x: 150, y: 400 }).side).toBe("bottom");
  });

  it("comes in at the left otherwise", () => {
    expect(entryPoint(rect, { x: 0, y: 150 }).side).toBe("left");
  });

  it("slides along the side towards the source rather than centring", () => {
    const high = entryPoint(rect, { x: 0, y: 120 });
    const low = entryPoint(rect, { x: 0, y: 180 });
    expect(high.y).toBeLessThan(low.y);
    expect(high.y).not.toBe(low.y);
  });
});

describe("curve", () => {
  it("starts at the port and ends at the landing point", () => {
    const geometry = curve({ x: 0, y: 0 }, { x: 200, y: 0, side: "left" });
    expect(geometry.path.startsWith("M 0 0 C")).toBe(true);
    expect(geometry.path.endsWith("200 0")).toBe(true);
  });

  it("puts the midpoint between the ends", () => {
    const geometry = curve({ x: 0, y: 0 }, { x: 200, y: 0, side: "left" });
    expect(geometry.mid.x).toBeGreaterThan(0);
    expect(geometry.mid.x).toBeLessThan(200);
  });

  it("leaves room above or below when entering top or bottom", () => {
    const top = curve({ x: 0, y: 0 }, { x: 100, y: 200, side: "top" });
    expect(top.path).toContain("100 136");

    const bottom = curve({ x: 0, y: 0 }, { x: 100, y: 200, side: "bottom" });
    expect(bottom.path).toContain("100 264");
  });

  it("bulges outward when the arrow has to come back round to the right", () => {
    const geometry = curve({ x: 300, y: 0 }, { x: 100, y: 0, side: "right" });
    // The second control point must sit beyond the landing point, so the curve
    // wraps around to approach from the right rather than cutting through the
    // block. dx is 96 here, so it lands at 100 + 96.
    const [, secondControl] = geometry.path.split(", ");
    const controlX = Number(secondControl.split(" ")[0]);
    expect(controlX).toBeGreaterThan(100);
    expect(controlX).toBe(196);
  });
});

describe("labelSpot", () => {
  const geometry = curve({ x: 0, y: 100 }, { x: 300, y: 100, side: "left" });

  /*
    ANT-178. Two connections out of a fork part at once, one climbing and one
    falling. With the handle at each line's middle, the falling one's label
    was pushed up — onto the climbing one — so each label read as the other's.
  */
  it("puts a falling connection's label on its own side of a fork, not on the climbing one", () => {
    const up = curve({ x: 0, y: 200 }, { x: 300, y: 60, side: "left" });
    const down = curve({ x: 0, y: 206 }, { x: 300, y: 346, side: "left" });
    const handle = (mid: { x: number; y: number }): Rect => ({ left: mid.x - 8, top: mid.y - 8, w: 16, h: 16 });
    const upLabel = labelSpot(up, 30, 12, [handle(up.mid), handle(down.mid)]);
    const downLabel = labelSpot(down, 30, 12, [handle(up.mid), handle(down.mid)]);
    expect(upLabel.y).toBeLessThan(up.mid.y);
    expect(downLabel.y).toBeGreaterThan(down.mid.y);
  });

  it("sits on the line when nothing is in the way", () => {
    const spot = labelSpot(geometry, 30, 12, []);
    expect(spot).toEqual(geometry.mid);
  });

  it("moves off the line rather than sitting on a block", () => {
    const inTheWay: Rect = { left: geometry.mid.x - 60, top: 70, w: 120, h: 60 };
    const spot = labelSpot(geometry, 30, 12, [inTheWay]);
    expect(spot).not.toEqual(geometry.mid);
    // Clear of the block it was avoiding.
    const overlaps =
      spot.x + 30 > inTheWay.left - 7 &&
      spot.x - 30 < inTheWay.left + inTheWay.w + 7 &&
      spot.y + 12 > inTheWay.top - 7 &&
      spot.y - 12 < inTheWay.top + inTheWay.h + 7;
    expect(overlaps).toBe(false);
  });

  it("settles on a position it actually checked, even when none is clear", () => {
    // A wall of blocks leaves nowhere clear. The fallback used to be a fixed
    // 110 above the line, returned untested — and 110 falls between two
    // offsets the search had already rejected, so the hardest case was the one
    // case nothing was verified for (ANT-44).
    const wall = Array.from({ length: 12 }, (_, index) => ({
      left: geometry.mid.x - 400,
      top: geometry.mid.y - 600 + index * 100,
      w: 800,
      h: 100,
    }));
    const spot = labelSpot(geometry, 30, 12, wall);

    // The candidates are steps along the normal, which for this chord is
    // vertical, and they stop at the last offset the search tries.
    const offsets = [0, 18, 30, 44, 60, 78, 98, 120];
    expect(spot.x).toBeCloseTo(geometry.mid.x, 5);
    expect(offsets.some((offset) => Math.abs(Math.abs(spot.y - geometry.mid.y) - offset) < 0.001)).toBe(
      true,
    );
  });
});

describe("labelHalfSize", () => {
  it("grows with the text", () => {
    expect(labelHalfSize("a").halfW).toBeLessThan(labelHalfSize("a much longer label").halfW);
  });

  it("is shorter and narrower for a quiet label", () => {
    const quiet = labelHalfSize("done", { quiet: true });
    const loud = labelHalfSize("done");
    expect(quiet.halfW).toBeLessThan(loud.halfW);
    expect(quiet.halfH).toBeLessThan(loud.halfH);
  });

  it("is taller when a condition is shown under the label", () => {
    expect(labelHalfSize("x", { hasCondition: true }).halfH).toBeGreaterThan(
      labelHalfSize("x").halfH,
    );
  });

  // ANT-195: "Tests passed" over `tester.result == "passed"` was sized by the
  // name, and the condition ran under the steps beside it.
  it("is as wide as its condition when that is the longer line", () => {
    const named = labelHalfSize("Tests passed", { hasCondition: true });
    const full = labelHalfSize("Tests passed", { condition: 'tester.result == "passed"' });
    expect(full.halfW).toBeGreaterThan(named.halfW);
    expect(full.halfW * 2).toBeGreaterThanOrEqual('tester.result == "passed"'.length * 6.3);
    expect(full.halfH).toBe(named.halfH);
  });
});

describe("anchorFromPoint", () => {
  it("is the fraction of the block that was pointed at", () => {
    expect(anchorFromPoint(block(100, 100), { x: 198, y: 150 })).toEqual({
      u: 0.5,
      v: 0.5,
    });
  });

  it("round-trips back to the same landing point", () => {
    const rect = block(40, 60);
    const anchor = anchorFromPoint(rect, { x: 40, y: 110 });
    expect(entryPoint(rect, { x: 0, y: 0 }, anchor)).toMatchObject({
      x: 40,
      y: 110,
      side: "left",
    });
  });
});

describe("unconnectedStub", () => {
  it("draws a short stub to the right of the port", () => {
    const stub = unconnectedStub({ x: 100, y: 50 });
    expect(stub.path).toBe("M 100 50 L 154 50");
    expect(stub.label).toEqual({ x: 188, y: 50 });
  });
});

describe("portFromAnchor", () => {
  const rect = block(100, 100);

  it("puts the port on the side nearest the point the author dragged to", () => {
    expect(portFromAnchor(rect, { u: 0.5, v: 0.02 }).side).toBe("top");
    expect(portFromAnchor(rect, { u: 0.5, v: 0.98 }).side).toBe("bottom");
    expect(portFromAnchor(rect, { u: 0.02, v: 0.5 }).side).toBe("left");
    expect(portFromAnchor(rect, { u: 0.98, v: 0.5 }).side).toBe("right");
  });

  it("keeps the same distance from the block wherever it is put", () => {
    const rect2 = block(0, 0);
    expect(portFromAnchor(rect2, { u: 0.5, v: 0 })).toMatchObject({ y: -PORT_OFFSET });
    expect(portFromAnchor(rect2, { u: 0.5, v: 1 })).toMatchObject({ y: 100 + PORT_OFFSET });
    expect(portFromAnchor(rect2, { u: 0, v: 0.5 })).toMatchObject({ x: -PORT_OFFSET });
    expect(portFromAnchor(rect2, { u: 1, v: 0.5 })).toMatchObject({ x: 196 + PORT_OFFSET });
  });

  it("slides along the side rather than jumping to its middle", () => {
    const high = portFromAnchor(rect, { u: 1, v: 0.25 });
    const low = portFromAnchor(rect, { u: 1, v: 0.75 });
    expect(high.y).toBeLessThan(low.y);
  });

  it("stays put for a point dragged outside the block", () => {
    const point = portFromAnchor(rect, { u: 4, v: 0.5 });
    expect(point.side).toBe("right");
    expect(point.x).toBe(rect.left + rect.w + PORT_OFFSET);
  });

  it("round-trips a canvas point back to the same port", () => {
    const anchor = anchorFromPoint(rect, { x: 296, y: 140 });
    expect(portFromAnchor(rect, anchor)).toMatchObject({ side: "right", y: 140 });
  });
});

describe("curve – leaving from a moved port", () => {
  it("sets off upwards from a port on the top of a block", () => {
    const geometry = curve({ x: 100, y: 100, side: "top" }, { x: 300, y: 100, side: "left" });
    const firstControl = geometry.path.split("C ")[1].split(",")[0];
    const [, controlY] = firstControl.split(" ").map(Number);
    expect(controlY).toBeLessThan(100);
  });

  it("leaves to the right when no side is given, as ports used to", () => {
    const geometry = curve({ x: 0, y: 0 }, { x: 200, y: 0, side: "left" });
    expect(geometry.path.startsWith("M 0 0 C 96 0")).toBe(true);
  });
});

describe("curve – bend", () => {
  const from = { x: 0, y: 100, side: "right" as const };
  const to = { x: 300, y: 100, side: "left" as const };

  it("is the plain curve when there is no bend", () => {
    expect(curve(from, to, { along: 0, across: 0 }).path).toBe(curve(from, to).path);
  });

  it("moves the middle of the line and leaves the ends alone", () => {
    const bent = curve(from, to, { along: 0, across: -0.2 });
    expect(bent.mid.y).toBeLessThan(curve(from, to).mid.y);
    expect(bent.path.startsWith("M 0 100 C")).toBe(true);
    expect(bent.path.endsWith("300 100")).toBe(true);
  });

  it("puts the middle exactly where it was dragged, so the handle follows the cursor", () => {
    const target = { x: 190, y: 40 };
    const bend = bendFromPoint(from, to, "curved", target);
    const bent = curve(from, to, bend);
    expect(bent.mid.x).toBeCloseTo(target.x, 6);
    expect(bent.mid.y).toBeCloseTo(target.y, 6);
  });

  it("survives the blocks moving, because it is relative to the line", () => {
    const bend = bendFromPoint(from, to, "curved", { x: 150, y: 40 });
    const moved = curve(
      { x: 0, y: 300, side: "right" },
      { x: 300, y: 300, side: "left" },
      bend,
    );
    // 60 above the line before the move, 60 above it after.
    expect(moved.mid.y).toBeCloseTo(240, 6);
  });
});

describe("elbow", () => {
  const from = { x: 0, y: 100, side: "right" as const };
  const to = { x: 300, y: 200, side: "left" as const };

  it("draws only horizontal and vertical segments", () => {
    const points = elbow(from, to)
      .path.split(/[ML] /)
      .slice(1)
      .map((pair) => pair.trim().split(" ").map(Number));

    for (let index = 1; index < points.length; index += 1) {
      const [x1, y1] = points[index - 1];
      const [x2, y2] = points[index];
      expect(x1 === x2 || y1 === y2).toBe(true);
    }
  });

  it("runs straight out of each block before turning", () => {
    expect(elbow(from, to).path).toContain(`M 0 100 L ${ELBOW_STUB} 100`);
    expect(elbow(from, to).path.endsWith(`L ${300 - ELBOW_STUB} 200 L 300 200`)).toBe(true);
  });

  it("turns half way between the two straight runs", () => {
    // 26 out of the source, 274 at the target: the turn is at 150.
    expect(elbow(from, to).path).toContain("L 150 100 L 150 200");
  });

  it("moves the turn when the line is bent", () => {
    // 20% of the way from 26 to 274 instead of half.
    const early = elbow(from, to, { along: -0.3, across: 0 });
    expect(early.path).toContain("L 75.6 100 L 75.6 200");
  });

  it("steps out sideways rather than back over the block it just left", () => {
    // Target behind the port: a turn on the departure axis would run backwards
    // through the source block.
    const back = elbow(from, { x: -200, y: 300, side: "right" });
    expect(back.turn).toBe("y");
    expect(back.path).toContain(`M 0 100 L ${ELBOW_STUB} 100`);
  });

  it("comes back round level with the target, not through the block it left", () => {
    // Entering the top of a block that sits below and behind the port. Crossing
    // half way would cut through the source card; crossing at the target's own
    // straight run is clear of both.
    const back = elbow(from, { x: -100, y: 400, side: "top" });
    expect(back.path).toBe(
      `M 0 100 L ${ELBOW_STUB} 100 L ${ELBOW_STUB} ${400 - ELBOW_STUB} ` +
        `L -100 ${400 - ELBOW_STUB} L -100 400`,
    );
  });

  it("puts its middle on the line, for the label and the bend handle", () => {
    const geometry = elbow(from, to);
    expect(geometry.mid).toEqual({ x: 150, y: 150 });
  });

  it("drops a corner rather than repeating a point when ends line up", () => {
    const straight = elbow(from, { x: 300, y: 100, side: "left" });
    expect(straight.path).toBe("M 0 100 L 26 100 L 150 100 L 274 100 L 300 100");
  });
});

describe("bendFromPoint – stepped lines", () => {
  const from = { x: 0, y: 100, side: "right" as const };
  const to = { x: 300, y: 200, side: "left" as const };

  it("puts the turn under the cursor", () => {
    const bend = bendFromPoint(from, to, "orthogonal", { x: 100, y: 150 });
    expect(elbow(from, to, bend).path).toContain("L 100 100 L 100 200");
  });

  it("only moves the turn, since a stepped line bends nowhere else", () => {
    expect(bendFromPoint(from, to, "orthogonal", { x: 100, y: 999 }).across).toBe(0);
  });
});

describe("route", () => {
  const from = { x: 0, y: 100, side: "right" as const };
  const to = { x: 300, y: 200, side: "left" as const };

  it("curves by default", () => {
    expect(route(from, to).path).toBe(curve(from, to).path);
    expect(route(from, to, { routing: "curved" }).path).toBe(curve(from, to).path);
  });

  it("steps when asked to", () => {
    expect(route(from, to, { routing: "orthogonal" }).path).toBe(elbow(from, to).path);
  });
});

/**
 * ANT-44. Label placement was block-aware and routing was not, so a connection
 * reaching past several blocks was drawn straight through them and vanished
 * behind each one — on a workflow laid out in one row, that is every loop and
 * every skip. The rework lines that stayed readable did so because they arced
 * clear of the row; this makes the rest do the same.
 */
describe("getting a line past what is in its way", () => {
  /** A row of five blocks, evenly spaced, the shape the bug was reported on. */
  const row = Array.from({ length: 5 }, (_, index) => ({
    left: index * 260,
    top: 100,
    w: 200,
    h: 90,
  }));

  const rightPort = (block: (typeof row)[number]) => ({
    x: block.left + block.w + 8,
    y: block.top + block.h / 2,
    side: "right" as const,
  });
  const leftPort = (block: (typeof row)[number]) => ({
    x: block.left - 8,
    y: block.top + block.h / 2,
    side: "left" as const,
  });
  const leftEdge = (block: (typeof row)[number]) => ({
    x: block.left,
    y: block.top + block.h / 2,
    side: "left" as const,
  });
  const rightEdge = (block: (typeof row)[number]) => ({
    x: block.left + block.w,
    y: block.top + block.h / 2,
    side: "right" as const,
  });

  /**
   * Whether a drawn path passes over any block other than the two it joins.
   *
   * Sampling the path is what the router itself does; asserting on the path
   * string would test the shape rather than the thing that matters.
   */
  function passesUnder(geometry: ReturnType<typeof route>, blocks: typeof row): boolean {
    const points: { x: number; y: number }[] = [];
    const numbers = geometry.path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    if (geometry.path.startsWith("M") && geometry.path.includes("C")) {
      const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = numbers;
      for (let step = 0; step <= 60; step += 1) {
        const t = step / 60;
        const m = 1 - t;
        points.push({
          x: m * m * m * x0 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * x1,
          y: m * m * m * y0 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * y1,
        });
      }
    } else {
      const corners: { x: number; y: number }[] = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) {
        corners.push({ x: numbers[index], y: numbers[index + 1] });
      }
      for (let index = 0; index + 1 < corners.length; index += 1) {
        for (let step = 0; step <= 40; step += 1) {
          points.push({
            x: corners[index].x + ((corners[index + 1].x - corners[index].x) * step) / 40,
            y: corners[index].y + ((corners[index + 1].y - corners[index].y) * step) / 40,
          });
        }
      }
    }

    const ends = [
      { x: geometry.from.x, y: geometry.from.y },
      { x: geometry.to.x, y: geometry.to.y },
    ];
    const inside = (block: (typeof row)[number], point: { x: number; y: number }, pad: number) =>
      point.x > block.left - pad &&
      point.x < block.left + block.w + pad &&
      point.y > block.top - pad &&
      point.y < block.top + block.h + pad;

    return blocks.some(
      (block) =>
        !ends.some((end) => inside(block, end, 10)) &&
        points.some((point) => inside(block, point, 2)),
    );
  }

  it("takes a long connection over the row rather than through it", () => {
    const geometry = route(rightPort(row[0]), leftEdge(row[4]), { blocks: row });
    expect(passesUnder(geometry, row)).toBe(false);
  });

  it("does the same for one going backwards", () => {
    // The reported case: a rework line from the far end back to the start.
    const geometry = route(leftPort(row[4]), rightEdge(row[0]), { blocks: row });
    expect(passesUnder(geometry, row)).toBe(false);
  });

  it("does the same for a stepped line, which cannot bend its way out", () => {
    // A stepped line's two long runs sit at the heights of its ends, so on one
    // row it has to leave the row entirely or not at all.
    const geometry = route(rightPort(row[0]), leftEdge(row[4]), {
      routing: "orthogonal",
      blocks: row,
    });
    expect(passesUnder(geometry, row)).toBe(false);
  });

  /**
   * ANT-121, both halves of it, on the shape it was reported from: a row with
   * a second row stacked above it, so the short way out of the row is the one
   * that is occupied.
   */
  it("goes the long way round when the near way out is occupied", () => {
    // A ceiling over the middle of the row, with its own gap above the blocks
    // it covers: going up clears the row and lands inside the ceiling.
    const ceiling = [
      { left: 500, top: -40, w: 200, h: 120 },
      { left: 760, top: -40, w: 200, h: 120 },
    ];
    const blocks = [...row, ...ceiling];
    const geometry = route(rightPort(row[0]), leftEdge(row[4]), { blocks });
    expect(passesUnder(geometry, blocks)).toBe(false);
  });

  it("measures its way past a block taller than the step it was taking", () => {
    // A neighbour reaching far above the row. Stepping out by fixed multiples
    // of the clearance put every attempt inside it; the way past is read off
    // the block that was actually met.
    const tower = { left: 560, top: -400, w: 200, h: 500 };
    const blocks = [...row, tower];
    const geometry = route(rightPort(row[0]), leftEdge(row[4]), { blocks });
    expect(passesUnder(geometry, blocks)).toBe(false);
  });

  it("leaves a connection between neighbours exactly as it was", () => {
    const port = rightPort(row[0]);
    const landing = leftEdge(row[1]);
    expect(route(port, landing, { blocks: row }).path).toBe(route(port, landing).path);
  });

  it("keeps a bend the author made, even through the row", () => {
    const port = rightPort(row[0]);
    const landing = leftEdge(row[4]);
    const bend = { along: 0.1, across: 0.05 };
    expect(route(port, landing, { blocks: row, bend }).path).toBe(
      route(port, landing, { bend }).path,
    );
  });

  it("is unchanged when it is not told what is on the canvas", () => {
    const port = rightPort(row[0]);
    const landing = leftEdge(row[4]);
    expect(route(port, landing).path).toBe(curve(port, landing).path);
  });
});

describe("unconnectedStub – from a moved port", () => {
  it("points the way the port faces", () => {
    expect(unconnectedStub({ x: 100, y: 50, side: "top" }).path).toBe("M 100 50 L 100 -4");
    expect(unconnectedStub({ x: 100, y: 50, side: "left" }).label).toEqual({ x: 12, y: 50 });
  });
});

/**
 * Which edge an output leaves from.
 *
 * ANT-39. Every port used to leave the right edge whatever it connected to, so
 * a rework edge — the one that sends work back to an earlier step — set off
 * forwards and swept around the block to get where it was going. On a workflow
 * with several loops those sweeps crossed everything on the canvas.
 */
describe("the side an output leaves from", () => {
  const at = (left: number, top = 0): Rect => ({ left, top, w: 190, h: 64 });

  it("leaves forwards for a target further along", () => {
    expect(portSideToward(at(0), at(400))).toBe("right");
  });

  it("leaves backwards for a target behind it", () => {
    expect(portSideToward(at(600), at(0))).toBe("left");
  });

  it("stays forwards for a target merely above or below", () => {
    // The diagram reads left to right; a port wandering off for a vertical
    // offset would be noise.
    expect(portSideToward(at(300, 0), at(300, 400))).toBe("right");
    expect(portSideToward(at(300, 400), at(300, 0))).toBe("right");
  });

  it("stays forwards for a target that only just overlaps behind", () => {
    // The bar is deliberately high: the target has to be properly behind
    // before a port doubles back.
    expect(portSideToward(at(300), at(200))).toBe("right");
  });

  it("puts the port outside the edge it names", () => {
    const rect = at(100, 100);
    expect(portPoint(rect, 0, 1, "left").x).toBeLessThan(rect.left);
    expect(portPoint(rect, 0, 1, "right").x).toBeGreaterThan(rect.left + rect.w);
    expect(portPoint(rect, 0, 1, "top").y).toBeLessThan(rect.top);
    expect(portPoint(rect, 0, 1, "bottom").y).toBeGreaterThan(rect.top + rect.h);
  });

  it("spreads ports along the side, not on top of each other", () => {
    const rect = at(0);
    const first = portPoint(rect, 0, 2, "left");
    const second = portPoint(rect, 1, 2, "left");
    expect(first.y).not.toBe(second.y);
    expect(first.x).toBe(second.x);
  });

  it("sets off away from the block, whichever side it is on", () => {
    // The curve leaves along this vector, so a left port pointing right would
    // start by going through its own block.
    expect(outward(portPoint(at(0), 0, 1, "left").side).x).toBeLessThan(0);
    expect(outward(portPoint(at(0), 0, 1, "right").side).x).toBeGreaterThan(0);
  });

  it("still defaults to forwards when no side is named", () => {
    expect(portPoint(at(0), 0, 1).side).toBe("right");
  });
});

/**
 * An arch no bigger than getting past things requires.
 *
 * A bend is stored as a fraction of the chord, so the same stored value means
 * a larger and larger arch as its two ends move apart. `layout.ts` chooses a
 * loop's apex in absolute terms — clear the corridor by a fixed margin — and
 * that intent is lost the moment the fraction meets a longer chord: the arch
 * inflates although the obstacles have not moved. On the workflow this was
 * reported from, one long skip bowed 179px off its own chord and dived below
 * the block it was arriving at, while the two connections beside it bowed 20
 * and 17 (ANT-53).
 */
describe("an arch fitted to the corridor rather than to the chord", () => {
  const row = Array.from({ length: 6 }, (_, index) => ({
    left: index * 300,
    top: 200,
    w: 200,
    h: 100,
  }));

  const from = { x: row[0].left + row[0].w + 8, y: 250, side: "right" as const };
  const to = { x: row[5].left, y: 250, side: "left" as const };

  /** How far a drawn line strays from the straight run between its ends. */
  function bow(geometry: ReturnType<typeof route>): number {
    const numbers = (geometry.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = numbers;
    const dx = geometry.to.x - geometry.from.x;
    const dy = geometry.to.y - geometry.from.y;
    const length = Math.hypot(dx, dy) || 1;
    let worst = 0;
    for (let step = 0; step <= 60; step += 1) {
      const t = step / 60;
      const m = 1 - t;
      const x = m * m * m * x0 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * x1;
      const y = m * m * m * y0 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * y1;
      const off = Math.abs((x - geometry.from.x) * dy - (y - geometry.from.y) * dx) / length;
      if (off > worst) worst = off;
    }
    return worst;
  }

  function crossesAny(geometry: ReturnType<typeof route>): boolean {
    const numbers = (geometry.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = numbers;
    for (let step = 0; step <= 90; step += 1) {
      const t = step / 90;
      const m = 1 - t;
      const x = m * m * m * x0 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * x1;
      const y = m * m * m * y0 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * y1;
      for (const r of row.slice(1, 5)) {
        if (x > r.left + 2 && x < r.left + r.w - 2 && y > r.top + 2 && y < r.top + r.h - 2) {
          return true;
        }
      }
    }
    return false;
  }

  /** Far more arch than clearing one row of blocks could ever need. */
  const inflated = { along: 0, across: 0.34 };

  it("tightens an arch the blocks do not justify", () => {
    const loose = route(from, to, { bend: inflated });
    const fitted = route(from, to, { bend: inflated, blocks: row });
    expect(bow(loose)).toBeGreaterThan(300);
    expect(bow(fitted)).toBeLessThan(bow(loose) / 2);
  });

  it("still gets the line past everything in the way", () => {
    expect(crossesAny(route(from, to, { bend: inflated, blocks: row }))).toBe(false);
  });

  it("leaves a modest bend alone rather than flattening every curve", () => {
    const small = { along: 0, across: 0.02 };
    expect(route(from, to, { bend: small, blocks: row }).path).toBe(
      route(from, to, { bend: small }).path,
    );
  });

  it("changes nothing when it was given no blocks to reason about", () => {
    expect(route(from, to, { bend: inflated }).path).toBe(
      curve(from, to, inflated).path,
    );
  });

  it("leaves a stepped line alone, which has no arch to trim", () => {
    expect(route(from, to, { routing: "orthogonal", bend: inflated, blocks: row }).path).toBe(
      elbow(from, to, inflated).path,
    );
  });

  /**
   * The safety net. Trimming may only ever tighten a line that was already
   * clear; it must never buy a smaller arch with a new crossing.
   */
  it("keeps the wider arch when a tighter one would cut through a block", () => {
    const tall = row.map((r, index) => (index > 0 && index < 5 ? { ...r, top: 120, h: 260 } : r));
    const fitted = route(from, to, { bend: inflated, blocks: tall });
    const points = (geometry: ReturnType<typeof route>) => {
      const n = (geometry.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      return n;
    };
    // Whatever it settles on, it is not drawn through the taller blocks.
    const n = points(fitted);
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = n;
    let hit = false;
    for (let step = 0; step <= 90; step += 1) {
      const t = step / 90;
      const m = 1 - t;
      const x = m * m * m * x0 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * x1;
      const y = m * m * m * y0 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * y1;
      for (const r of tall.slice(1, 5)) {
        if (x > r.left + 2 && x < r.left + r.w - 2 && y > r.top + 2 && y < r.top + r.h - 2) hit = true;
      }
    }
    expect(hit).toBe(false);
  });
});
