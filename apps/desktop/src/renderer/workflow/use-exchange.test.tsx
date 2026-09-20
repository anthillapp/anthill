/**
 * The one read of the exchange the whole workflow screen shares.
 *
 * This hook used to write as well: `approve` and `withdraw`, and most of these
 * tests were about the shapes those two sent. Both went with the approval
 * gate, so what is pinned now is the reading — that it does not read without
 * a file to read against, that a save brings the view back up to date, and
 * that a read which threw is shown rather than leaving a stale handover up.
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExchangeView } from "../../shared/ipc.js";
import { useExchange } from "./use-exchange.js";

afterEach(cleanup);

const view: ExchangeView = {
  workflowId: "w",
  revision: 3,
  digest: "sha256:abc",
  state: "ready_for_agent",
  mode: "design",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
  problems: [],
  bindings: [],
};

function api(over: Partial<ExchangeView> = {}) {
  const methods = { exchangeRead: vi.fn(async () => ({ ...view, ...over })) };
  (window as unknown as { anthill: unknown }).anthill = methods;
  return methods;
}

it("reads nothing until the workflow has a file to be read against", async () => {
  const methods = api();
  renderHook(() => useExchange("w"));
  await waitFor(() => expect(methods.exchangeRead).not.toHaveBeenCalled());
});

it("reads the handover the open file belongs to", async () => {
  const methods = api();
  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json"));
  await waitFor(() => expect(result.current.view).toMatchObject({ revision: 3 }));
  expect(methods.exchangeRead).toHaveBeenCalledWith("/tmp/workflow.json", "w");
});

/**
 * A save is what the third argument is for.
 *
 * Autosave writes a new revision, and the view describing the old one would
 * then be a revision behind on the screen the user is looking at.
 */
it("reads again when the save state changes", async () => {
  const methods = api();
  const { result, rerender } = renderHook(
    ({ dirty }: { dirty: boolean }) => useExchange("w", "/tmp/workflow.json", dirty),
    { initialProps: { dirty: true } },
  );
  await waitFor(() => expect(result.current.view).toBeTruthy());
  const before = methods.exchangeRead.mock.calls.length;

  rerender({ dirty: false });

  await waitFor(() => expect(methods.exchangeRead.mock.calls.length).toBeGreaterThan(before));
});

it("surfaces a read that threw rather than showing a stale handover", async () => {
  const methods = { exchangeRead: vi.fn(async () => { throw new Error("the exchange directory disappeared"); }) };
  (window as unknown as { anthill: unknown }).anthill = methods;

  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json"));

  await waitFor(() => expect(result.current.error).toContain("exchange directory disappeared"));
  expect(result.current.view).toBeUndefined();
});
