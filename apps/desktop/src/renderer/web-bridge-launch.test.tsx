import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installWebBridge } from "../../../cli/src/web-bridge.js";
import { LaunchWindow } from "./LaunchWindow.js";

/**
 * The browser shell's contract, checked at the seam where it can break.
 *
 * The renderer is one bundle in two shells: Electron gets `window.anthill` from
 * the preload, the browser gets it from `installWebBridge()`. The two answers
 * must agree on the method set, or the shared renderer throws the moment it
 * calls a method only one shell offered. This is how `piModels` was lost:
 * the preload had it, the web bridge did not, and the Launch screen — which
 * calls `window.anthill.piModels()` on every mount — threw
 * `TypeError: window.anthill.piModels is not a function` in the browser.
 *
 * The renderer test (`LaunchWindow.test.tsx`) cannot catch that: it writes
 * `window.anthill` by hand and includes `piModels`, so it tests the renderer
 * against a contract it invented. This test mounts the same screen against the
 * real `installWebBridge()` API, with a stub socket standing in for the server.
 */

/**
 * A just-enough WebSocket: it opens on the next tick, records what the page
 * sends, and answers the one channel this test is about. Every other channel
 * stays pending — the renderer tolerates a slow server, and the test only
 * needs the `pi:models` round trip to prove the method is on the wire.
 */
class StubWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = StubWebSocket.CONNECTING;
  readonly url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(url: string) {
    this.url = url;
    lastSocket = this;
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

  send(data: string) {
    this.sent.push(data);
    const request = JSON.parse(data) as { id: number; channel: string };
    if (request.channel === "pi:models") {
      const response = JSON.stringify({
        id: request.id,
        channel: request.channel,
        result: { models: [] },
      });
      queueMicrotask(() => this.fire("message", { data: response }));
    }
  }

  close() {
    this.readyState = StubWebSocket.CLOSED;
  }

  private fire(event: string, payload?: unknown) {
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }
}

let lastSocket: StubWebSocket | undefined;

describe("the browser shell offers the renderer's full contract", () => {
  beforeEach(() => {
    lastSocket = undefined;
    vi.stubGlobal("WebSocket", StubWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { anthill?: unknown }).anthill;
  });

  it("mounts LaunchWindow without a missing-method TypeError and asks for the pi catalogue", async () => {
    // The real web bridge, not a hand-written stand-in. If it lacks piModels,
    // the mount below throws the TypeError the review is about.
    const api = await installWebBridge();
    expect(typeof api.piModels).toBe("function");
    expect(typeof window.anthill.piModels).toBe("function");

    render(
      <LaunchWindow
        onNewWorkflow={() => undefined}
        onFromPrompt={() => undefined}
        onOpen={() => undefined}
        onOpenLive={() => undefined}
        onExplain={() => undefined}
        onFromSession={() => undefined} onWelcomeTour={() => undefined} onShowTips={() => undefined}
        onSettings={() => undefined}
      />,
    );

    // The screen called piModels() on mount; the request must be on the wire.
    await waitFor(() => {
      expect(
        lastSocket?.sent.some(
          (message) => (JSON.parse(message) as { channel: string }).channel === "pi:models",
        ),
      ).toBe(true);
    });
  });
});
