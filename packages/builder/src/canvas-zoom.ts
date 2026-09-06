/**
 * Trackpad zoom for a canvas, as macOS actually delivers it.
 *
 * Both gestures arrive as `wheel` events and are told apart by one flag:
 *
 * - **Pinch.** Chromium synthesises a wheel event with `ctrlKey` set. Spreading
 *   the fingers gives a negative `deltaY`, matching the browser's own
 *   ctrl-and-scroll zoom, so spreading zooms in.
 * - **Two-finger vertical.** An ordinary wheel event. With macOS's default
 *   "natural scrolling", moving the fingers *up* scrolls the content down and
 *   gives a **positive** `deltaY` — so fingers up zooms in.
 *
 * The two therefore read opposite signs, which looks like a bug until you
 * notice they are different gestures with different conventions. Hence two
 * branches rather than one clever expression.
 *
 * **The platform limitation, stated plainly:** the sign of an ordinary wheel
 * event follows the system's scroll-direction setting, and a page cannot read
 * that setting. With "natural scrolling" turned off, the vertical gesture
 * inverts — fingers up zooms out. Pinch is unaffected, because its sign is set
 * by the gesture rather than by the preference.
 *
 * Everything here is pure: a view and an event in, the next view out. That is
 * what lets the two canvases share exact behaviour rather than two drifting
 * imitations of it, and what makes momentum testable without a trackpad.
 */

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
/** One press of `+` or `−`, and the unit the keyboard shortcut uses. */
export const ZOOM_STEP = 1.15;

/** Pan and zoom of a canvas. */
export type ZoomView = { x: number; y: number; scale: number };

/** A point in the container's own coordinates. */
export type Focal = { x: number; y: number };

export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * Zoom by a factor, holding one point of the canvas still.
 *
 * Without a focal point the diagram slides out from under the cursor as it
 * grows, which is the difference between zooming in on something and zooming
 * in near it.
 */
export function zoomAbout(view: ZoomView, factor: number, focal: Focal): ZoomView {
  const scale = clampScale(view.scale * factor);
  // Nothing moves when the bound was already reached; the ratio is 1 and the
  // arithmetic below is a no-op, but returning early keeps that obvious.
  if (scale === view.scale) return view;

  const ratio = scale / view.scale;
  return {
    scale,
    x: focal.x - (focal.x - view.x) * ratio,
    y: focal.y - (focal.y - view.y) * ratio,
  };
}

/* ------------------------------------------------------------------ */
/* Wheel events                                                        */
/* ------------------------------------------------------------------ */

/** How much scale one pixel of gesture is worth. Tuned to feel like Preview. */
const PINCH_SENSITIVITY = 0.01;
const WHEEL_SENSITIVITY = 0.0035;

/**
 * The most one event may move the zoom.
 *
 * Momentum keeps events arriving after the fingers lift, and a line-mode or
 * page-mode wheel can report a very large delta. Clamping per event means the
 * worst a spike can do is one ordinary step, so the zoom cannot bolt.
 */
const MAX_DELTA = 40;

/** Wheels report pixels, lines or pages. Only pixels are comparable. */
function toPixels(delta: number, mode: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * 100;
  return delta;
}

function clampDelta(delta: number): number {
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
}

/** What a wheel event over the canvas means. */
export type WheelIntent =
  | { kind: "zoom"; factor: number; focal: Focal }
  /** Horizontal two-finger movement: the canvas slides sideways. */
  | { kind: "pan"; dx: number; dy: number }
  /** Nothing worth acting on — a stray event with no movement in it. */
  | { kind: "ignore" };

export type WheelLike = {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  clientX?: number;
  clientY?: number;
};

/** The container's position on screen, for turning a client point into a focal one. */
export type ContainerBox = { left: number; top: number };

/**
 * Read one wheel event.
 *
 * Horizontal movement pans rather than zooming: a trackpad's sideways swipe
 * already means "move along" everywhere else, and taking it for zoom would
 * cost the canvas a navigation people already have.
 */
export function readWheel(event: WheelLike, box: ContainerBox = { left: 0, top: 0 }): WheelIntent {
  const dx = toPixels(event.deltaX, event.deltaMode ?? 0);
  const dy = toPixels(event.deltaY, event.deltaMode ?? 0);

  const focal: Focal = {
    x: (event.clientX ?? 0) - box.left,
    y: (event.clientY ?? 0) - box.top,
  };

  if (event.ctrlKey) {
    // Pinch. Spreading gives a negative delta, so the sign is flipped to make
    // spreading grow the diagram.
    if (dy === 0) return { kind: "ignore" };
    return { kind: "zoom", factor: Math.exp(-clampDelta(dy) * PINCH_SENSITIVITY), focal };
  }

  // A gesture that is mostly sideways is a pan, and only a clearly vertical one
  // zooms — otherwise a slightly-off horizontal swipe would zoom by accident.
  if (Math.abs(dx) > Math.abs(dy)) {
    return { kind: "pan", dx: -dx, dy: 0 };
  }

  if (dy === 0) return { kind: "ignore" };
  // Fingers up gives a positive delta under natural scrolling, and zooms in.
  return { kind: "zoom", factor: Math.exp(clampDelta(dy) * WHEEL_SENSITIVITY), focal };
}

/** Fold one wheel event into the next view. Returns the same view when inert. */
export function applyWheel(
  view: ZoomView,
  event: WheelLike,
  box: ContainerBox = { left: 0, top: 0 },
): ZoomView {
  const intent = readWheel(event, box);
  if (intent.kind === "zoom") return zoomAbout(view, intent.factor, intent.focal);
  if (intent.kind === "pan") return { ...view, x: view.x + intent.dx, y: view.y + intent.dy };
  return view;
}

/**
 * Whether a gesture that landed here belongs to the canvas.
 *
 * A wheel over a field, a menu or a list is that control's business — a canvas
 * that zoomed while someone scrolled a dropdown would be taking a gesture it
 * was not given.
 */
export function isCanvasGesture(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return true;
  return !element.closest(
    "input, textarea, select, option, [contenteditable='true'], [role='listbox'], [role='menu'], [role='dialog'], .inspector, .libraries, .live-side, .live-rail, .modal, .modal-scrim",
  );
}
