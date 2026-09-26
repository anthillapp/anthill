/**
 * The unsupported Windows build (ANT-154): a notice once per version, then a
 * grey chip that stays — and nothing at all anywhere else.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnsupportedWindowsChip, UnsupportedWindowsProvider } from "./unsupported-windows.js";
import { WindowsGate } from "./WindowsGate.js";

let api: Record<string, ReturnType<typeof vi.fn>>;

function shell(platform: string, channels: string[] = ["app:quit"]) {
  api = {
    capabilities: vi.fn(async () => ({ contract: 25, channels, shell: "desktop", platform })),
    openLink: vi.fn(async () => undefined),
    quit: vi.fn(async () => true),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
}

async function show(version = "0.7.11") {
  await act(async () => {
    render(
      <UnsupportedWindowsProvider version={version}>
        <header>
          <UnsupportedWindowsChip skin="on-dark" />
        </header>
        <WindowsGate />
      </UnsupportedWindowsProvider>,
    );
  });
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("on Windows", () => {
  it("shows the notice first, with the four things to know, focused on Continue", async () => {
    shell("win32");
    await show();
    const dialog = await screen.findByRole("dialog", { name: "Windows support is coming soon" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Experimental source build");
    expect(dialog.textContent).toMatch(/hasn.t been validated here yet/);
    expect(dialog.textContent).toContain("no compatibility, data-safety or support guarantee");
    expect(dialog.textContent).toContain("You can keep going if you accept that.");
    expect(document.activeElement?.textContent).toBe("Continue experimentally");
    // The chip waits: the notice is already saying it.
    expect(screen.queryByRole("button", { name: "Unsupported Windows build" })).toBeNull();
  });

  it("continues into the app, and keeps a grey chip in view that reports", async () => {
    shell("win32");
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Continue experimentally" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const chip = screen.getByRole("button", { name: "Unsupported Windows build" });
    expect(chip.getAttribute("title")).toMatch(/unsupported, experimental Windows build/);
    fireEvent.click(chip);
    expect(api.openLink).toHaveBeenCalledWith("windowsIssue");
  });

  it("does not ask again for the same version, and asks again for a new one", async () => {
    shell("win32");
    await show("0.7.11");
    fireEvent.click(await screen.findByRole("button", { name: "Continue experimentally" }));
    cleanup();

    await show("0.7.11");
    await waitFor(() => expect(screen.getByRole("button", { name: "Unsupported Windows build" })).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    await show("0.7.12");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("reports without dismissing, and exits the desktop app", async () => {
    shell("win32");
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Report a Windows issue" }));
    expect(api.openLink).toHaveBeenCalledWith("windowsIssue");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Exit" }));
    expect(api.quit).toHaveBeenCalled();
  });

  it("offers no Exit where there is nothing to quit", async () => {
    shell("win32", []);
    await show();
    await screen.findByRole("dialog");
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Exit" })).toBeNull();
  });
});

describe("anywhere else", () => {
  it.each(["darwin", "linux"])("shows neither notice nor chip on %s", async (platform) => {
    shell(platform);
    await show();
    await waitFor(() => expect(api.capabilities).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Unsupported Windows build" })).toBeNull();
  });
});
