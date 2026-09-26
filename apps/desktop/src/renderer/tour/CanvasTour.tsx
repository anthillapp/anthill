/**
 * Coach marks over the real workflow screen (ANT-141).
 *
 * A ring around one real control, a one-sentence card beside it, and a dim
 * just deep enough to make the ring the thing you look at. The layer takes no
 * clicks — only the card does — so the reader can use the control the card is
 * pointing at; the tour never fakes an interaction and never blocks one.
 *
 * Every hint is looked up when it is shown. A control that is missing, tiny,
 * or not at least half inside the window is given one chance to be scrolled
 * into view (the nearest scroll containers, never `scrollIntoView`, which
 * would move the whole window) and is otherwise skipped, in whichever
 * direction the reader was going — so Back never lands on nothing. The ring
 * and the card follow their target as the window resizes, panels scroll, or
 * the layout shifts under them.
 *
 * Keyboard: focus lands on Next at every step (found by its own marker, not
 * by position — a positional pick once landed on Skip tour and one Enter
 * ended the tour); Back and Skip tour are ordinary buttons; Escape closes.
 * On close, focus goes to the control last pointed at, or back to where it
 * was before the tour began.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { fromDom, intersect, placeCard, ringRect, showable, type Rect } from "./tour-geometry.js";
import type { TourStep } from "./tour-steps.js";

export type CanvasTourProps = {
  steps: TourStep[];
  /** Finished, skipped or dismissed — all the same to the caller. */
  onClose: () => void;
};

const windowRect = (): Rect => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });

/** How long the first look waits for the canvas to draw, and how often it looks again. */
const START_WAIT_MS = 250;
const START_TRIES = 12;

/** Scroll the target's scrolling ancestors just enough to bring it into view. */
function reveal(target: HTMLElement): void {
  for (let node = target.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    const scrolls = /(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`);
    if (!scrolls) continue;
    const box = node.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < box.top) node.scrollTop -= box.top - rect.top + 8;
    else if (rect.bottom > box.bottom) node.scrollTop += rect.bottom - box.bottom + 8;
    if (rect.left < box.left) node.scrollLeft -= box.left - rect.left + 8;
    else if (rect.right > box.right) node.scrollLeft += rect.right - box.right + 8;
  }
}

/**
 * The part of an element its clipping ancestors actually let through.
 *
 * The window is not the only edge. A block on the canvas can sit inside the
 * window and still be hidden under the left rail, because the canvas clips
 * what it has panned out of view — and a ring drawn there outlines the rail.
 * So every ancestor that clips is intersected in, and "half visible" is
 * judged against what survives.
 */
export function clippedRect(node: HTMLElement): Rect | undefined {
  let rect: Rect | undefined = fromDom(node.getBoundingClientRect());
  for (let at = node.parentElement; at && rect && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (/(hidden|auto|scroll|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
      rect = intersect(rect, fromDom(at.getBoundingClientRect()));
    }
  }
  return rect;
}

/** Whether enough of the element survives its clipping to be pointed at. */
function seen(node: HTMLElement): boolean {
  const whole = fromDom(node.getBoundingClientRect());
  const visible = clippedRect(node);
  if (!visible || !showable(whole, windowRect())) return false;
  return (visible.w * visible.h) / (whole.w * whole.h) >= 0.5;
}

/** The control a step points at, if it is there to point at — after one attempt to reveal it. */
export function findTarget(anchor: string): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)];
  const visible = () => candidates.find(seen);
  const now = visible();
  if (now) return now;
  if (candidates[0]) {
    reveal(candidates[0]);
    return visible();
  }
  return undefined;
}

export function CanvasTour({ steps, onClose }: CanvasTourProps) {
  const [index, setIndex] = useState<number | undefined>();
  const [target, setTarget] = useState<HTMLElement>();
  const [ring, setRing] = useState<Rect>();
  const [card, setCard] = useState<Rect>();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<Element | null>(null);
  const textId = useId();

  /** The first step from `from` onwards (or backwards) whose control is there. */
  const land = useCallback(
    (from: number, direction: 1 | -1) => {
      for (let at = from; at >= 0 && at < steps.length; at += direction) {
        const found = findTarget(steps[at].anchor);
        if (found) {
          setIndex(at);
          setTarget(found);
          return true;
        }
      }
      return false;
    },
    [steps],
  );

  const close = useCallback(
    (focus?: HTMLElement) => {
      onClose();
      const back = focus ?? (returnTo.current instanceof HTMLElement ? returnTo.current : undefined);
      back?.focus?.();
    },
    [onClose],
  );

  // Start on the first control that is there. The canvas draws its blocks in
  // after it mounts, so the first look is given a moment rather than taken as
  // the answer; only a screen that never shows any of them ends the tour.
  useEffect(() => {
    returnTo.current = document.activeElement;
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      if (land(0, 1)) return;
      tries += 1;
      if (tries >= START_TRIES) onClose();
      else timer = window.setTimeout(attempt, START_WAIT_MS);
    };
    timer = window.setTimeout(attempt, START_WAIT_MS);
    return () => window.clearTimeout(timer);
    // Once, on mount: the steps do not change under a running tour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback(
    (direction: 1 | -1) => {
      if (index === undefined) return;
      if (land(index + direction, direction)) return;
      // Nothing further on is there to point at: Next finishes, Back stays.
      if (direction === 1) close(target);
    },
    [index, land, close, target],
  );

  // Follow the target: every frame, re-measure, and move only when it moved.
  // Resizes, inner scrolls and layout shifts all show up as a changed rect.
  useLayoutEffect(() => {
    if (!target) return;
    let frame = 0;
    let last = "";
    const measure = () => {
      if (!target.isConnected) {
        // The control went away under the tour (a tab switched, a panel
        // closed). Move on rather than point at where it was.
        if (index !== undefined && !land(index + 1, 1)) close();
        return;
      }
      const win = windowRect();
      // What is really visible of it: the ring outlines that, not the parts
      // a panel has clipped away.
      const rect = clippedRect(target) ?? fromDom(target.getBoundingClientRect());
      const height = cardRef.current?.offsetHeight ?? 200;
      const key = `${rect.x},${rect.y},${rect.w},${rect.h},${win.w},${win.h},${height}`;
      if (key !== last) {
        last = key;
        const nextRing = seen(target) ? ringRect(rect, win) : undefined;
        setRing(nextRing);
        if (nextRing) setCard(placeCard(nextRing, height, win));
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [target, index, land, close]);

  // Focus Next on every step, by its marker — once the card is placed. Until
  // its first measurement it is `visibility: hidden`, and a hidden button
  // cannot take focus: the attempt fails silently and focus stays on the body.
  const placed = card !== undefined;
  useEffect(() => {
    if (index === undefined || !placed) return;
    cardRef.current?.querySelector<HTMLButtonElement>("[data-tour-next]")?.focus();
  }, [index, placed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(target);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, target]);

  if (index === undefined || !target) return null;
  const step = steps[index];
  const kind = target.dataset.tourKind;
  const copy = (kind && step.kinds?.[kind]) || { title: step.title, text: step.text };
  const last = !steps.slice(index + 1).some((next) => document.querySelector(`[data-tour="${next.anchor}"]`));
  const targetName = target.getAttribute("aria-label") ?? target.textContent?.trim().slice(0, 60) ?? copy.title;

  return createPortal(
    <div className="tour-layer" aria-hidden={false}>
      {ring ? (
        <div className="tour-ring" style={{ left: ring.x, top: ring.y, width: ring.w, height: ring.h }} />
      ) : null}
      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={textId}
        style={card ? { left: card.x, top: card.y } : { visibility: "hidden" }}
      >
        <div className="head">
          <span className="title">{copy.title}</span>
          <button type="button" className="skip" onClick={() => close(target)}>
            Skip tour
          </button>
        </div>
        <p id={textId} className="text" aria-live="polite">
          {copy.text}
          <span className="sr-only"> Highlighted: {copy.title}{targetName !== copy.title ? ` – ${targetName}` : ""}.</span>
        </p>
        <div className="foot">
          <span className="count">
            {index + 1} of {steps.length}
          </span>
          {index > 0 ? (
            <button type="button" className="back" onClick={() => go(-1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="next" data-tour-next onClick={() => (last ? close(target) : go(1))}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
