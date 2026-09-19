/**
 * Whether an element is being scrolled *right now*.
 *
 * A scrollbar answers a question you are already asking — how much more is
 * there, and where am I — and nobody asks it of a list they are not moving.
 * macOS agrees: its own overlay bars appear on the gesture and fade after it.
 * Anthill has to draw its own on the dark rail, because the system's is
 * invisible against it, and drawing it permanently left a bar standing beside
 * a list that is mostly sitting still.
 *
 * So: a flag while the wheel is turning, and off again a beat after it stops.
 * The beat is the point — clearing it on the last event makes the bar flicker
 * between the events of one continuous gesture.
 */

import { useEffect, useState } from "react";

/** How long after the last scroll event the bar stays. One unhurried beat. */
const LINGER_MS = 700;

export function useScrolling<T extends HTMLElement>(): {
  /** Give this to the scrolling element. */
  ref: (node: T | null) => void;
  scrolling: boolean;
} {
  // The node is state rather than a ref so attaching the listener is an effect
  // with a dependency, which React will re-run if the element is replaced.
  const [node, setNode] = useState<T | null>(null);
  const [scrolling, setScrolling] = useState(false);

  useEffect(() => {
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      setScrolling(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), LINGER_MS);
    };

    // Passive: this listener never prevents the scroll it is watching.
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [node]);

  return { ref: setNode, scrolling };
}
