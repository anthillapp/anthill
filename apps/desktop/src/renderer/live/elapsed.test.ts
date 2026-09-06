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

import { relative, useNow } from "./elapsed.js";

describe("saying how long ago something happened", () => {
  const at = "2026-08-29T10:00:00.000Z";
  const base = Date.parse(at);

  it("counts in seconds, then minutes, then hours", () => {
    expect(relative(at, base + 3_000)).toBe("3s ago");
    expect(relative(at, base + 90_000)).toBe("1m ago");
    expect(relative(at, base + 2 * 3_600_000)).toBe("2h ago");
  });

  it("says nothing rather than zero when there is no time to report", () => {
    expect(relative(undefined, base)).toBe("—");
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
