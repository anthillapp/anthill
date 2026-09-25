import { useEffect, useRef } from "react";

/** Poll only while the setup surface is mounted and visible; never overlap reads. */
export function useSetupPoll(read: () => Promise<void>, enabled = true, pending = true) {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let running = false;
    let delay = 15_000;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (stopped || running) return;
      clearTimeout(timer);
      running = true;
      try { if (document.visibilityState !== "hidden") await latest.current(); }
      catch { /* Keep the last snapshot; callers display request failures. */ }
      finally {
        running = false;
        if (!stopped && pending) {
          delay = Math.min(delay * 2, 60_000);
          timer = setTimeout(() => void check(), delay);
        }
      }
    };
    const focus = () => void check();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    if (pending) timer = setTimeout(focus, delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [enabled, pending]);
}
