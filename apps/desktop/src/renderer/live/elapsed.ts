/**
 * How long ago something happened, and keeping that answer true.
 *
 * Both places that show this are making a claim about how fresh Anthill's
 * evidence is, which is the one thing the observation surfaces exist to be
 * honest about. Computing it during render alone is not enough: a page that
 * stops re-rendering because the session stopped writing keeps whatever label
 * it last drew, so a session that ended five minutes ago went on reading "Last
 * seen 1s ago" for as long as the page stayed open — the reading is most wrong
 * in exactly the case it matters most.
 */

import { useEffect, useState } from "react";

/** Close enough to be honest, far enough apart to cost nothing. */
const TICK_MS = 5_000;

export function relative(at: string | undefined, now: number = Date.now()): string {
  if (!at) return "—";
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * A clock that re-renders the component holding it.
 *
 * Returns the current time, so a label derived from it goes stale by at most
 * one tick rather than by however long the session has been quiet.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
