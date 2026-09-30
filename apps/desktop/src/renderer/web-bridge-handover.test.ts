import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installWebBridge } from "../../../cli/src/web-bridge.js";

/**
 * ANT-228. The page side of a handover in the browser shell.
 *
 * The bridge sends a handover to one tab as `{path, deliveryId}`, and the page
 * answers with the id and what became of it — the desktop's handshake over a
 * WebSocket. A tab opened at `/workflow/<id>` names that workflow when it
 * first collects, and a refused handover is said in the tab.
 */

class StubWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = StubWebSocket.CONNECTING;
  sent: { id: number; channel: string; args: unknown[] }[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(readonly url: string) {
    socket = this;
    queueMicrotask(() => {
      this.readyState = StubWebSocket.OPEN;
      this.fire("open");
    });
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(listener);
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== listener);
  }

  /** Every request is answered at once, with nothing. */
  send(data: string) {
    const request = JSON.parse(data) as { id: number; channel: string; args: unknown[] };
    this.sent.push(request);
    queueMicrotask(() => this.fire("message", { data: JSON.stringify({ id: request.id, channel: request.channel, result: null }) }));
  }

  /** A push from the server. */
  push(channel: string, payload: unknown) {
    this.fire("message", { data: JSON.stringify({ channel, payload }) });
  }

  close() {
    this.readyState = StubWebSocket.CLOSED;
  }

  private fire(event: string, payload?: unknown) {
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }
}

let socket: StubWebSocket | undefined;

describe("a handover in the browser shell's page", () => {
  beforeEach(() => {
    socket = undefined;
    vi.stubGlobal("WebSocket", StubWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    delete (window as unknown as { anthill?: unknown }).anthill;
  });

  it("names the workflow its /workflow/<id> URL is for, on the first collection only", async () => {
    window.history.replaceState(null, "", "/workflow/wf%201?token=abc");
    const api = await installWebBridge();

    await api.pendingWorkflowOpen();
    await api.pendingWorkflowOpen();

    const collections = socket!.sent.filter((request) => request.channel === "workflow:pending-open");
    expect(collections.map((request) => request.args)).toEqual([["wf 1"], []]);
  });

  it("names nothing from any other URL", async () => {
    window.history.replaceState(null, "", "/?token=abc");
    const api = await installWebBridge();

    await api.pendingWorkflowOpen();

    expect(socket!.sent.find((request) => request.channel === "workflow:pending-open")?.args).toEqual([]);
  });

  it("hands the page the path and delivery id, and sends its answer back with both", async () => {
    const api = await installWebBridge();
    const listener = vi.fn();
    api.onOpenWorkflow(listener);

    socket!.push("app:open-workflow", { path: "/data/exchange/wf/working.json", deliveryId: 7 });
    expect(listener).toHaveBeenCalledWith("/data/exchange/wf/working.json", 7);

    await api.workflowOpened("/data/exchange/wf/working.json", 7, "declined");
    expect(socket!.sent.find((request) => request.channel === "workflow:opened")?.args)
      .toEqual(["/data/exchange/wf/working.json", 7, "declined"]);
  });

  it("says a refused handover in the tab", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    await installWebBridge();

    socket!.push("app:handover-refused", "Workflow nope is missing or unreadable in this Anthill data directory.");

    expect(alert).toHaveBeenCalledWith(expect.stringContaining("Workflow nope is missing"));
  });
});
