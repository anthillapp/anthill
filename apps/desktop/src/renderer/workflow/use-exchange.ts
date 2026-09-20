/**
 * One read of the exchange for the whole workflow screen.
 *
 * The toolbar's pill and the floating notice describe the same handover, so
 * they read it once here rather than twice. This used to live inside the band
 * that drew them together; the band is gone and its polling is not, because
 * the state changes outside the app — somebody else's session binds a
 * revision, and nothing tells us.
 *
 * It used to write as well as read: `approve` and `withdraw` recorded the
 * user's decision in the exchange. Both went with the approval gate, and this
 * is a read now.
 */

import { useEffect, useState } from "react";
import type { ExchangeView } from "../../shared/ipc.js";

/**
 * How often the exchange is re-read.
 *
 * Short enough that a binding made in another window appears while the reader
 * is still looking at the screen, and the reason the notice floats rather than
 * sitting in the layout: at this rate a card can appear while nobody is
 * interacting, and the canvas must not jump under their cursor when it does.
 */
const POLL_MS = 2000;

export type ExchangeAccess = {
  view?: ExchangeView;
  /** What the last read failed with. Not the same as a refusal. */
  error?: string;
};

export function useExchange(workflowId: string, path?: string, reread?: unknown): ExchangeAccess {
  const [view, setView] = useState<ExchangeView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    // One read at a time: a slow answer must not let the next tick start a
    // second, or a burst of them lands out of order and the last to arrive
    // wins regardless of which is newest.
    let reading = false;
    setView(undefined);
    setError(undefined);
    const read = async () => {
      if (!path || !window.anthill.exchangeRead || reading) return;
      reading = true;
      try {
        const next = await window.anthill.exchangeRead(path, workflowId);
        if (current) {
          setView(next);
          setError(undefined);
        }
      } catch (problem) {
        if (current) setError(String(problem));
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [path, workflowId, reread]);

  return { ...(view ? { view } : {}), ...(error ? { error } : {}) };
}
