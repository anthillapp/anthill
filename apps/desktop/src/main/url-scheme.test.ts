import { describe, expect, it, vi } from "vitest";

import { WORKFLOW_SCHEME, claimScheme, type SchemeHost } from "./url-scheme.js";

function host(over: Partial<SchemeHost> = {}): SchemeHost & { setAsDefaultProtocolClient: ReturnType<typeof vi.fn> } {
  return {
    isPackaged: true,
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: vi.fn(() => true),
    ...over,
  } as never;
}

describe("who opens anthill:// links", () => {
  /**
   * ANT-137. On macOS a dev run registers the stock Electron.app — every dev
   * Electron's bundle id — and LaunchServices then hands links to any
   * Electron.app on the disk. A dev run must never register at all.
   */
  it("is never a dev run, even when the scheme is unclaimed", () => {
    const dev = host({ isPackaged: false });
    expect(claimScheme(dev)).toBe(false);
    expect(dev.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("is the installed app, which claims its scheme when it has lost it", () => {
    const installed = host();
    expect(claimScheme(installed)).toBe(true);
    expect(installed.setAsDefaultProtocolClient).toHaveBeenCalledWith(WORKFLOW_SCHEME);
  });

  it("leaves a claim that already holds alone", () => {
    const installed = host({ isDefaultProtocolClient: () => true });
    expect(claimScheme(installed)).toBe(false);
    expect(installed.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
