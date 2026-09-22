/**
 * Reading a macOS trackpad through `wheel` events.
 *
 * The two gestures arrive on the same event and read opposite signs, so most
 * of these tests are about direction: a pinch that grows must grow the diagram,
 * and fingers moving up must do the same, even though one reports a negative
 * delta and the other a positive one.
 */

import { describe, expect, it } from "vitest";

import {
  ZOOM_MAX,
  ZOOM_MIN,
  HOST_EXCLUSIONS,
  applyWheel,
  clampScale,
  isCanvasGesture,
  readWheel,
  zoomAbout,
  type ZoomView,
} from "./canvas-zoom";

const start: ZoomView = { x: 0, y: 0, scale: 1 };
const box = { left: 0, top: 0 };

/** A pinch: Chromium sets `ctrlKey`; spreading reports a negative delta. */
const pinch = (deltaY: number) => ({ deltaX: 0, deltaY, ctrlKey: true, clientX: 100, clientY: 100 });
/** Two fingers, vertical: an ordinary wheel event. */
const swipe = (deltaY: number) => ({ deltaX: 0, deltaY, clientX: 100, clientY: 100 });

describe("which gesture this is", () => {
  it("reads a spreading pinch as zooming in", () => {
    const intent = readWheel(pinch(-10), box);
    expect(intent.kind).toBe("zoom");
    expect((intent as { factor: number }).factor).toBeGreaterThan(1);
  });

  it("reads a closing pinch as zooming out", () => {
    expect((readWheel(pinch(10), box) as { factor: number }).factor).toBeLessThan(1);
  });

  it("reads fingers moving up as zooming in", () => {
    // Natural scrolling: fingers up scrolls the content down, so deltaY > 0.
    expect((readWheel(swipe(12), box) as { factor: number }).factor).toBeGreaterThan(1);
  });

  it("reads fingers moving down as zooming out", () => {
    expect((readWheel(swipe(-12), box) as { factor: number }).factor).toBeLessThan(1);
  });

  it("pans on a sideways swipe instead of zooming", () => {
    const intent = readWheel({ deltaX: 30, deltaY: 2, clientX: 0, clientY: 0 }, box);
    expect(intent).toEqual({ kind: "pan", dx: -30, dy: 0 });
  });

  it("only zooms on a clearly vertical gesture", () => {
    // A swipe that is mostly sideways must not zoom by accident.
    expect(readWheel({ deltaX: 20, deltaY: 19 }, box).kind).toBe("pan");
    expect(readWheel({ deltaX: 19, deltaY: 20 }, box).kind).toBe("zoom");
  });

  it("does nothing with an event carrying no movement", () => {
    expect(readWheel({ deltaX: 0, deltaY: 0 }, box).kind).toBe("ignore");
    expect(readWheel({ deltaX: 0, deltaY: 0, ctrlKey: true }, box).kind).toBe("ignore");
  });

  it("converts line and page deltas before judging them", () => {
    // One line is worth far more than one pixel; comparing them raw would make
    // a line-mode wheel do almost nothing.
    const pixels = readWheel({ deltaX: 0, deltaY: 16 }, box) as { factor: number };
    const lines = readWheel({ deltaX: 0, deltaY: 1, deltaMode: 1 }, box) as { factor: number };
    expect(lines.factor).toBeCloseTo(pixels.factor, 6);
  });
});

describe("where the zoom happens", () => {
  it("holds the point under the pointer still", () => {
    const focal = { x: 200, y: 120 };
    const next = zoomAbout(start, 2, focal);
    // The canvas point under the focal stays under it: (focal - x) / scale.
    const before = (focal.x - start.x) / start.scale;
    const after = (focal.x - next.x) / next.scale;
    expect(after).toBeCloseTo(before, 6);
  });

  it("zooms about the pointer, not the origin", () => {
    const next = applyWheel(start, pinch(-20), box);
    expect(next.scale).toBeGreaterThan(1);
    expect(next.x).not.toBe(0);
  });

  it("leaves the view untouched when already at the bound", () => {
    const atMax: ZoomView = { x: 5, y: 6, scale: ZOOM_MAX };
    expect(zoomAbout(atMax, 2, { x: 100, y: 100 })).toBe(atMax);
  });
});

describe("bounds and momentum", () => {
  it("never goes past either limit", () => {
    expect(clampScale(99)).toBe(ZOOM_MAX);
    expect(clampScale(0.001)).toBe(ZOOM_MIN);
  });

  it("stops at the ceiling however hard the gesture pushes", () => {
    let view = start;
    for (let i = 0; i < 200; i += 1) view = applyWheel(view, pinch(-30), box);
    expect(view.scale).toBe(ZOOM_MAX);
  });

  it("stops at the floor however hard the gesture pushes", () => {
    let view = start;
    for (let i = 0; i < 200; i += 1) view = applyWheel(view, swipe(-30), box);
    expect(view.scale).toBe(ZOOM_MIN);
  });

  it("clamps one enormous momentum spike to an ordinary step", () => {
    // Momentum, and page-mode wheels, can report huge deltas. One event must
    // never be able to cross the whole range.
    const spike = applyWheel(start, pinch(-4000), box);
    const ordinary = applyWheel(start, pinch(-40), box);
    expect(spike.scale).toBeCloseTo(ordinary.scale, 6);
    expect(spike.scale).toBeLessThan(ZOOM_MAX);
  });

  it("settles rather than drifting as momentum decays", () => {
    // A decaying tail must converge; each event moves the scale less than the
    // one before it.
    let view = start;
    const steps: number[] = [];
    for (const delta of [-30, -18, -9, -4, -1]) {
      const next = applyWheel(view, pinch(delta), box);
      steps.push(next.scale - view.scale);
      view = next;
    }
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]).toBeLessThan(steps[i - 1]);
  });
});

describe("whose gesture it is", () => {
  it.each([
    "input",
    "textarea",
    "select",
  ])("leaves a %s alone", (tag) => {
    const element = document.createElement(tag);
    document.body.appendChild(element);
    expect(isCanvasGesture(element)).toBe(false);
    element.remove();
  });

  it.each([
    ["the inspector", "inspector"],
    ["the library rail", "libraries"],
    ["the activity feed", "live-side"],
    ["the session rail", "live-rail"],
  ])("leaves %s alone when the host passes its classes", (_name, className) => {
    const panel = document.createElement("div");
    panel.className = className;
    const inner = document.createElement("div");
    panel.appendChild(inner);
    document.body.appendChild(panel);
    expect(isCanvasGesture(inner, HOST_EXCLUSIONS)).toBe(false);
    panel.remove();
  });

  it("does not know the host's class names by default", () => {
    for (const className of ["inspector", "live-rail", "modal-scrim"]) {
      const panel = document.createElement("div");
      panel.className = className;
      document.body.appendChild(panel);
      expect(isCanvasGesture(panel)).toBe(true);
      panel.remove();
    }
  });

  it("leaves a modal and an open menu alone", () => {
    for (const attrs of [{ role: "dialog" }, { role: "menu" }, { role: "listbox" }]) {
      const element = document.createElement("div");
      Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
      document.body.appendChild(element);
      expect(isCanvasGesture(element)).toBe(false);
      element.remove();
    }
  });

  it("takes a gesture over the canvas itself", () => {
    const canvas = document.createElement("div");
    canvas.className = "canvas-area";
    document.body.appendChild(canvas);
    expect(isCanvasGesture(canvas)).toBe(true);
    canvas.remove();
  });
});
