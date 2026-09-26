/**
 * Where the tour's ring and card go (ANT-141).
 *
 * Pure arithmetic over rects, so the rules the handoff sets can be tested
 * without a browser laying anything out:
 *
 * - a target is only pointed at when it is really there — at least 4px each
 *   way and at least half of it inside the window;
 * - the ring is the visible part of the target, padded by up to 4px but never
 *   past the window's edge;
 * - the card is placed by its measured height, below, above, right or left,
 *   the first that fits inside the window with a 12px margin — and when none
 *   fits, clamped, but never over the target it points at.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export const CARD_WIDTH = 300;
export const MARGIN = 12;
const PAD = 4;
const MIN_SIZE = 4;

export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

/** Whether a target is there to point at: big enough, and at least half inside the window. */
export function showable(target: Rect, win: Rect): boolean {
  if (target.w < MIN_SIZE || target.h < MIN_SIZE) return false;
  const seen = intersect(target, win);
  if (!seen) return false;
  return (seen.w * seen.h) / (target.w * target.h) >= 0.5;
}

/** The visible part of the target, padded by up to 4px and kept inside the window. */
export function ringRect(target: Rect, win: Rect): Rect | undefined {
  const seen = intersect(target, win);
  if (!seen) return undefined;
  const x = Math.max(win.x, seen.x - PAD);
  const y = Math.max(win.y, seen.y - PAD);
  const right = Math.min(win.x + win.w, seen.x + seen.w + PAD);
  const bottom = Math.min(win.y + win.h, seen.y + seen.h + PAD);
  return { x, y, w: right - x, h: bottom - y };
}

const overlaps = (a: Rect, b: Rect) => intersect(a, b) !== undefined;

const inside = (card: Rect, win: Rect) =>
  card.x >= win.x + MARGIN &&
  card.y >= win.y + MARGIN &&
  card.x + card.w <= win.x + win.w - MARGIN &&
  card.y + card.h <= win.y + win.h - MARGIN;

function clamp(card: Rect, win: Rect): Rect {
  const x = Math.min(Math.max(card.x, win.x + MARGIN), win.x + win.w - MARGIN - card.w);
  const y = Math.min(Math.max(card.y, win.y + MARGIN), win.y + win.h - MARGIN - card.h);
  return { ...card, x: Math.max(win.x, x), y: Math.max(win.y, y) };
}

/** The card's place, given the ring it points at and its own measured height. */
export function placeCard(ring: Rect, height: number, win: Rect, width = CARD_WIDTH): Rect {
  const candidates: Rect[] = [
    { x: ring.x, y: ring.y + ring.h + MARGIN, w: width, h: height },
    { x: ring.x, y: ring.y - height - MARGIN, w: width, h: height },
    { x: ring.x + ring.w + MARGIN, y: ring.y, w: width, h: height },
    { x: ring.x - width - MARGIN, y: ring.y, w: width, h: height },
  ];
  const fits = candidates.find((card) => inside(card, win));
  if (fits) return fits;
  const clamped = candidates.map((card) => clamp(card, win));
  return clamped.find((card) => !overlaps(card, ring)) ?? clamped[0];
}

/** A DOMRect as a Rect. */
export const fromDom = (rect: { left: number; top: number; width: number; height: number }): Rect => ({
  x: rect.left,
  y: rect.top,
  w: rect.width,
  h: rect.height,
});
