/**
 * The application's own zoom stays locked.
 *
 * The canvases cancel their own gestures, but that only covers the elements
 * they listen on. A pinch over the sidebar, the launch window or a modal would
 * otherwise reach Chromium's page zoom and scale the whole interface — the one
 * outcome the canvas gesture exists to avoid.
 */

import { describe, expect, it, vi } from "vitest";

describe("the preload's window-zoom guard", () => {
  it("pins the visual zoom to 1 before anything is exposed", async () => {
    const setVisualZoomLevelLimits = vi.fn();
    const exposeInMainWorld = vi.fn();

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
      webFrame: { setVisualZoomLevelLimits },
    }));

    await import("./index.js");

    expect(setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    expect(exposeInMainWorld).toHaveBeenCalledWith("anthill", expect.any(Object));
    vi.doUnmock("electron");
  });
});
