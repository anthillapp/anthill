/**
 * Attaching the trackpad gestures to a canvas element.
 *
 * The listener is added by hand rather than through React's `onWheel` for one
 * reason that matters: it has to be **non-passive**. A passive listener cannot
 * call `preventDefault`, and without that the same gesture also scrolls the
 * page and — on a pinch — asks Chromium to zoom the whole application. The
 * canvas would zoom and so would the sidebar around it.
 *
 * It is attached to the canvas element alone, so a gesture over the inspector,
 * the block library or a modal never reaches it. `isCanvasGesture` covers the
 * remaining case: a field or a menu rendered *inside* the canvas.
 */

import { useEffect, type RefObject } from "react";

import { applyWheel, isCanvasGesture, type ZoomView } from "./canvas-zoom";

export function useWheelZoom(
  surface: RefObject<HTMLElement | null>,
  setView: (next: (current: ZoomView) => ZoomView) => void,
  enabled = true,
  excludedSelectors?: string,
): void {
  useEffect(() => {
    const element = surface.current;
    if (!element || !enabled) return;

    const onWheel = (event: WheelEvent) => {
      if (!isCanvasGesture(event.target, excludedSelectors)) return;

      // Taken before anything is computed: this is what keeps the gesture off
      // the application's own zoom and off the page's scroll.
      event.preventDefault();

      const box = element.getBoundingClientRect();
      setView((current) => applyWheel(current, event, box));
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [surface, setView, enabled, excludedSelectors]);
}
