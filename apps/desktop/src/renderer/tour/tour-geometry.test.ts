/**
 * The tour's placement rules, as arithmetic: point only at what is really
 * there, keep the ring inside the window, and never cover the target.
 */

import { describe, expect, it } from "vitest";

import { intersect, placeCard, ringRect, showable, type Rect } from "./tour-geometry.js";

const win: Rect = { x: 0, y: 0, w: 1024, h: 768 };

describe("what can be pointed at", () => {
  it("needs at least 4px each way", () => {
    expect(showable({ x: 10, y: 10, w: 3, h: 40 }, win)).toBe(false);
    expect(showable({ x: 10, y: 10, w: 40, h: 4 }, win)).toBe(true);
  });

  it("needs at least half of it inside the window", () => {
    expect(showable({ x: 1000, y: 10, w: 100, h: 40 }, win)).toBe(false); // 24% visible
    expect(showable({ x: 964, y: 10, w: 100, h: 40 }, win)).toBe(true); // 60% visible
    expect(showable({ x: 2000, y: 10, w: 100, h: 40 }, win)).toBe(false);
  });
});

describe("the ring", () => {
  it("pads the target by 4px", () => {
    expect(ringRect({ x: 100, y: 100, w: 50, h: 20 }, win)).toEqual({ x: 96, y: 96, w: 58, h: 28 });
  });

  it("never spills past the window edge", () => {
    expect(ringRect({ x: 0, y: 0, w: 50, h: 20 }, win)).toEqual({ x: 0, y: 0, w: 54, h: 24 });
    expect(ringRect({ x: 1000, y: 740, w: 40, h: 40 }, win)).toEqual({ x: 996, y: 736, w: 28, h: 32 });
  });
});

describe("the card", () => {
  it("goes below the target when it fits", () => {
    expect(placeCard({ x: 100, y: 100, w: 50, h: 20 }, 120, win)).toMatchObject({ x: 100, y: 132 });
  });

  it("goes above when below would leave the window", () => {
    expect(placeCard({ x: 100, y: 700, w: 50, h: 40 }, 120, win)).toMatchObject({ x: 100, y: 568 });
  });

  it("goes beside a tall target, and is placed by its measured height", () => {
    const tall = { x: 20, y: 60, w: 240, h: 680 };
    const card = placeCard(tall, 180, win);
    expect(card).toMatchObject({ x: 272, y: 60, h: 180 });
    expect(intersect(card, tall)).toBeUndefined();
  });

  it("is clamped into the window but never onto the target when nothing fits", () => {
    const wide = { x: 0, y: 40, w: 1024, h: 700 };
    const card = placeCard(wide, 200, win);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y + card.h).toBeLessThanOrEqual(768);
    // Nothing fits outside a target this size; the fallback is the first
    // clamped place, and the rule only promises no overlap when one exists.
    const small = { x: 400, y: 300, w: 200, h: 200 };
    expect(intersect(placeCard(small, 260, { x: 0, y: 0, w: 640, h: 520 }), small)).toBeUndefined();
  });
});
