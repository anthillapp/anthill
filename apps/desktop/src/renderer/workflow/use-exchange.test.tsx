import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExchangeReadyResult, ExchangeView } from "../../shared/ipc.js";
import { useExchange } from "./use-exchange.js";

afterEach(cleanup);

const view: ExchangeView = {
  workflowId: "w",
  revision: 3,
  digest: "sha256:abc",
  mode: "approval-gate",
  state: "draft",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
  problems: [],
  bindings: [],
};

function api(over: Partial<ExchangeView> = {}, ready?: ExchangeReadyResult) {
  const methods = {
    exchangeRead: vi.fn(async () => ({ ...view, ...over })),
    exchangeReady: vi.fn(async (): Promise<ExchangeReadyResult> => ready ?? { ok: true }),
    exchangeRevoke: vi.fn(async (): Promise<ExchangeReadyResult> => ready ?? { ok: true }),
  };
  (window as unknown as { anthill: unknown }).anthill = methods;
  return methods;
}

it("reads nothing until the workflow has a file to be read against", async () => {
  const methods = api();
  renderHook(() => useExchange("w"));
  await waitFor(() => expect(methods.exchangeRead).not.toHaveBeenCalled());
});

it("names the revision and digest it read when it records an approval", async () => {
  const methods = api();
  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json", false));
  await waitFor(() => expect(result.current.view).toBeTruthy());
  await act(async () => {
    await result.current.approve(view.revision, view.digest);
  });
  expect(methods.exchangeReady).toHaveBeenCalledWith({
    path: "/tmp/workflow.json",
    workflowId: "w",
    revision: 3,
    digest: "sha256:abc",
  });
});

/*
 * Withdrawing carries no digest, unlike approving: the revision being taken
 * back is usually not the one the editor has open — that is the whole
 * situation it answers — so there is no head content to check it against.
 */
it("withdraws by revision alone", async () => {
  const methods = api();
  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json", false));
  await waitFor(() => expect(result.current.view).toBeTruthy());
  await act(async () => {
    await result.current.withdraw(1);
  });
  expect(methods.exchangeRevoke).toHaveBeenCalledWith({
    path: "/tmp/workflow.json",
    workflowId: "w",
    revision: 1,
  });
});

/*
 * A refusal is surfaced rather than swallowed, and it is not a read failure:
 * the screen turns it into the one red card in this feature, which says what
 * did *not* happen.
 */
it("keeps a refused write where the screen can say nothing was recorded", async () => {
  api({}, { ok: false, error: "the exchange file changed while Anthill was writing" });
  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json", false));
  await waitFor(() => expect(result.current.view).toBeTruthy());
  await act(async () => {
    await result.current.approve(3, "sha256:abc");
  });
  expect(result.current.error).toContain("changed while Anthill was writing");
});

it("re-reads the exchange after a decision, rather than assuming it landed", async () => {
  const methods = api();
  const { result } = renderHook(() => useExchange("w", "/tmp/workflow.json", false));
  await waitFor(() => expect(result.current.view).toBeTruthy());
  const before = methods.exchangeRead.mock.calls.length;
  await act(async () => {
    await result.current.approve(3, "sha256:abc");
  });
  await waitFor(() => expect(methods.exchangeRead.mock.calls.length).toBeGreaterThan(before));
});
