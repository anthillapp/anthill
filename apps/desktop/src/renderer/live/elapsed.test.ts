/**
 * The freshness label, and the clock that keeps it true.
 *
 * The bug this covers is not the arithmetic — that was always right — but the
 * fact that nothing recomputed it. A session that finished five minutes ago
 * went on reading "Last seen 1s ago", because the last render happened when
 * the last event arrived and nothing has re-rendered the page since.
 */

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relative, spanned, useNow } from "./elapsed.js";

describe("saying how long ago something happened", () => {
  const at = "2026-08-29T10:00:00.000Z";
  const base = Date.parse(at);

  it("counts in seconds, then minutes, then hours", () => {
    expect(relative(at, base + 3_000)).toBe("3s ago");
    expect(relative(at, base + 90_000)).toBe("1m ago");
    expect(relative(at, base + 2 * 3_600_000)).toBe("2h ago");
  });

  it("says nothing rather than zero when there is no time to report", () => {
    expect(relative(undefined, base)).toBe("–");
  });

  it("never counts backwards from a record written a moment ahead of the clock", () => {
    expect(relative(at, base - 4_000)).toBe("0s ago");
  });
});

describe("the clock behind the label", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves on its own, so a page that stopped re-rendering still tells the truth", () => {
    const { result } = renderHook(() => useNow());
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current - first).toBeGreaterThanOrEqual(30_000);
  });

  it("stops when the component goes away", () => {
    const { unmount } = renderHook(() => useNow());
    unmount();
    // A leaked interval would keep setting state on an unmounted component.
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The run's own total, to the minute.
 *
 * Seconds are right on a step and wrong here: on a run measured in hours they
 * are noise dressed as precision, and they would tick in a corner nobody is
 * watching for that.
 */
describe("how long a run has lasted", () => {
  const start = "2026-08-29T10:00:00.000Z";
  const after = (ms: number) => new Date(Date.parse(start) + ms).toISOString();

  it("counts whole minutes", () => {
    expect(spanned(start, after(12 * 60_000))).toBe("12m");
    // 59m 59s is not an hour, and saying "1h" would round time into existence.
    expect(spanned(start, after(59 * 60_000 + 59_000))).toBe("59m");
  });

  it("rolls over into hours, which minutes alone would not", () => {
    expect(spanned(start, after(60 * 60_000))).toBe("1h 0m");
    expect(spanned(start, after(84 * 60_000 + 30_000))).toBe("1h 24m");
    expect(spanned(start, after(5 * 3600_000 + 7 * 60_000))).toBe("5h 7m");
  });

  it("says a run that just began lasted something, not nothing", () => {
    expect(spanned(start, after(40_000))).toBe("under a minute");
    expect(spanned(start, after(0))).toBe("under a minute");
  });

  it("takes the end as a clock reading too, for a session still going", () => {
    expect(spanned(start, Date.parse(start) + 30 * 60_000)).toBe("30m");
  });

  it("says nothing when the record cannot support an answer", () => {
    expect(spanned(undefined, after(60_000))).toBe("–");
    expect(spanned(start, undefined)).toBe("–");
    expect(spanned("not a date", after(60_000))).toBe("–");
    // An end before the start is two clocks disagreeing, not a negative run.
    expect(spanned(after(60_000), start)).toBe("–");
  });
});
