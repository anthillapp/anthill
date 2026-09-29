/** ANT-183: blocks added from the library never land on each other. */
import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@anthill/workflow-schema";

import { openSpot } from "./placement.js";

const at = (id: string, x: number, y: number): WorkflowNode => ({ id, type: "agent", name: id, config: {}, position: { x, y } });

describe("where a block added from the library goes", () => {
  it("fills a row under a blank canvas's Start and Done, one after another, never overlapping", () => {
    const nodes: WorkflowNode[] = [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 80, y: 200 } },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 520, y: 200 } },
    ];
    for (let n = 0; n < 5; n += 1) {
      const spot = openSpot(nodes);
      for (const node of nodes) {
        const clash = Math.abs(node.position!.x - spot.x) < 196 && Math.abs(node.position!.y - spot.y) < 120;
        expect(clash).toBe(false);
      }
      expect(spot.y).toBeGreaterThan(200);
      nodes.push(at(`added-${n}`, spot.x, spot.y));
    }
    // The first three share a row.
    expect(new Set(nodes.slice(2, 5).map((node) => node.position!.y)).size).toBe(1);
  });

  it("has somewhere to put the first block of an empty canvas", () => {
    expect(openSpot([])).toEqual({ x: 120, y: 160 });
  });
});

/** ANT-205: nor on the "not connected" exits of the blocks already there. */
describe("where a block goes next to unconnected outputs", () => {
  const blank = (): WorkflowNode[] => [
    { id: "start", type: "start", name: "Start", config: {}, position: { x: 80, y: 200 } },
    { id: "end", type: "end", name: "Done", config: {}, position: { x: 520, y: 200 } },
  ];
  const condition = (x: number, y: number): WorkflowNode => ({
    id: "cond",
    type: "condition",
    name: "Condition",
    config: { pendingOutputs: [{ id: "o1" }, { id: "o2" }] },
    position: { x, y },
  });
  /** The stubs reach 88 units past the card, with their label beyond that. */
  const clearOfStubs = (spot: { x: number; y: number }, from: { x: number; y: number }) =>
    spot.x >= from.x + 196 + 130 || Math.abs(spot.y - from.y) >= 130;

  it("keeps an End clear of a Condition's unconnected exits", () => {
    const nodes = blank();
    const first = openSpot(nodes, { unconnectedOutputs: true });
    nodes.push(condition(first.x, first.y));
    const spot = openSpot(nodes);
    expect(clearOfStubs(spot, first)).toBe(true);
  });

  it("keeps a new block's own unconnected exits off the block to its right", () => {
    const nodes = blank();
    nodes.push(at("right", 316, 330));
    const spot = openSpot(nodes, { unconnectedOutputs: true });
    // Column 0 (x 80) would send its stub across the block at x 316.
    expect(spot).not.toEqual({ x: 80, y: 330 });
  });

  it("reads a stub on the bottom edge as reaching down", () => {
    const nodes = blank();
    nodes.push({
      ...condition(80, 330),
      config: { pendingOutputs: [{ id: "o1", port: { u: 0.5, v: 1 } }] },
    });
    // The rest of the Condition's row is taken, so the next free spot by
    // cards alone is the one right under it.
    for (let column = 1; column < 6; column += 1) nodes.push(at(`row-${column}`, 80 + column * 236, 330));
    const spot = openSpot(nodes);
    // Not straight under it, where the stub and its label are.
    expect(spot.x === 80 && spot.y === 460).toBe(false);
  });
});
