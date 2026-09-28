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
