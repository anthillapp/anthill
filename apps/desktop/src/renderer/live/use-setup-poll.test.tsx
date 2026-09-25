// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSetupPoll } from "./use-setup-poll.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("setup polling lifecycle", () => {
  it("backs off pending checks and stops scheduling after ready, but refreshes on focus", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {});
    const hook = renderHook(({ pending }) => useSetupPoll(read, true, pending), { initialProps: { pending: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(read).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(2);
    hook.rerender({ pending: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(read).toHaveBeenCalledTimes(3);
    hook.unmount();
    window.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("never overlaps a slow request", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderHook(() => useSetupPoll(read));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(60_000); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
