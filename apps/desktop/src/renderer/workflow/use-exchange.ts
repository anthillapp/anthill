/**
 * One read of the exchange for the whole workflow screen.
 *
 * The toolbar's pill, its primary button and the floating notice all describe
 * the same handover, so they read it once here rather than three times. This
 * used to live inside the band that drew all three together; the band is gone
 * and its polling is not, because the state changes outside the app — somebody
 * else's session binds a revision, and nothing tells us.
 */

import { useCallback, useEffect, useState } from "react";
import type { ExchangeReadyResult, ExchangeView } from "../../shared/ipc.js";

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
  /** What the last read or write failed with. Not the same as a refusal. */
  error?: string;
  approve: (revision: number, digest: string) => Promise<void>;
  withdraw: (revision: number) => Promise<void>;
  busy: boolean;
};

export function useExchange(workflowId: string, path?: string, dirty?: boolean): ExchangeAccess {
  const [view, setView] = useState<ExchangeView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

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
  }, [path, workflowId, dirty, refresh]);

  // Both decisions are recorded the same way: ask main, show what it says, and
  // read the exchange again so the screen describes what is now on disk rather
  // than what was just asked for.
  const record = useCallback(async (decide: () => Promise<ExchangeReadyResult>) => {
    setBusy(true);
    try {
      const result = await decide();
      if (!result.ok) setError(result.error);
      else {
        setError(undefined);
        setRefresh((value) => value + 1);
      }
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(
    async (revision: number, digest: string) => {
      if (!path || busy) return;
      await record(() => window.anthill.exchangeReady({ path, workflowId, revision, digest }));
    },
    [path, workflowId, busy, record],
  );

  const withdraw = useCallback(
    async (revision: number) => {
      if (!path || busy) return;
      await record(() => window.anthill.exchangeRevoke({ path, workflowId, revision }));
    },
    [path, workflowId, busy, record],
  );

  return { ...(view ? { view } : {}), ...(error ? { error } : {}), approve, withdraw, busy };
}
