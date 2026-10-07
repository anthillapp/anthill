/**
 * Updating Anthill on Settings ▸ About (ANT-76): what each state offers.
 *
 * Main owns the state and pushes it; these tests stand in for main and check
 * that every state shows the one next step it allows and nothing it does not —
 * a Restart before anything is downloaded, or a Try Again that could never
 * work, would be a promise the button cannot keep.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateState, UpdateStatus } from "../../shared/ipc.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { UpdateRows } from "./UpdateRows.js";

function stub(state: UpdateState, withUpdater = true) {
  let push: ((status: UpdateStatus) => void) | undefined;
  let stored = { updateChecks: true };
  const status = (next: UpdateState): UpdateStatus => ({ current: "0.8.9", state: next });
  const api = {
    settingsRead: vi.fn(async () => stored),
    settingsWrite: vi.fn(async (patch: Partial<typeof stored>) => (stored = { ...stored, ...patch })),
    openLink: vi.fn(async () => undefined),
    liveSetupStatus: vi.fn(async () => ({ dismissed: false, trigger: "", harnesses: [] })),
    ...(withUpdater
      ? {
          updateStatus: vi.fn(async () => status(state)),
          updateCheck: vi.fn(async () => status({ phase: "checking" })),
          updateDownload: vi.fn(async () => status(state)),
          updateCancel: vi.fn(async () => status(state)),
          updateInstall: vi.fn(async () => status(state)),
          onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
            push = listener;
            return () => undefined;
          }),
        }
      : {}),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return { api, push: (next: UpdateState) => act(() => push?.(status(next))) };
}

const button = (name: string) => screen.getByRole("button", { name });

/** Render, and let the first reads answer before anything is asserted. */
async function showRows() {
  render(<UpdateRows />);
  await act(async () => undefined);
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the update row", () => {
  it("checks when asked", async () => {
    const { api } = stub({ phase: "idle" });
    await showRows();
    await act(async () => fireEvent.click(button("Check for Updates")));
    expect(api.updateCheck).toHaveBeenCalledTimes(1);
  });

  it("says the installed version is the latest, and can check again", async () => {
    stub({ phase: "current", checkedAt: "2026-10-05T12:00:00.000Z" });
    await showRows();
    expect(await screen.findByText(/Anthill 0\.8\.9 is the latest release/)).toBeTruthy();
    expect(button("Check Again")).toBeTruthy();
  });

  it("offers a found release, says what updating keeps, and downloads only when asked", async () => {
    const { api } = stub({ phase: "available", version: "0.9.0", releaseDate: "2026-10-05T00:00:00.000Z" });
    await showRows();
    expect(await screen.findByText(/Anthill 0\.9\.0 is available/)).toBeTruthy();
    expect(screen.getByText(/workflows, agents and settings stay as they are/)).toBeTruthy();
    expect(api.updateDownload).not.toHaveBeenCalled();
    fireEvent.click(button("What's new"));
    expect(api.openLink).toHaveBeenCalledWith("releases");
    await act(async () => fireEvent.click(button("Download and Install")));
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Restart to Update" })).toBeNull();
  });

  it("shows a download's progress and lets it be cancelled", async () => {
    const { api, push } = stub({ phase: "available", version: "0.9.0" });
    await showRows();
    await screen.findByRole("button", { name: "Download and Install" });
    push({ phase: "downloading", version: "0.9.0", percent: 42, transferred: 42_000_000, total: 100_000_000 });
    expect(screen.getByText(/42% \(42\.0 of 100\.0 MB\)/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Downloading Anthill 0.9.0" }).getAttribute("value")).toBe("42");
    await act(async () => fireEvent.click(button("Cancel")));
    expect(api.updateCancel).toHaveBeenCalledTimes(1);
  });

  it("restarts only once the release is downloaded and verified", async () => {
    const { api } = stub({ phase: "ready", version: "0.9.0" });
    await showRows();
    await act(async () => fireEvent.click(button("Restart to Update")));
    expect(api.updateInstall).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/or it installs the next time you quit/)).toBeTruthy();
  });

  it("says what went wrong, retries what could work, and always offers GitHub", async () => {
    const { api, push } = stub({
      phase: "failed",
      during: "download",
      kind: "offline",
      message: "Anthill couldn't reach GitHub. Check your connection and try again.",
      retryable: true,
      version: "0.9.0",
    });
    await showRows();
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't reach GitHub/);
    await act(async () => fireEvent.click(button("Try Again")));
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(button("Download from GitHub"));
    expect(api.openLink).toHaveBeenCalledWith("releases");

    push({ phase: "failed", during: "download", kind: "signature", message: "Not signed.", retryable: false });
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
    expect(button("Download from GitHub")).toBeTruthy();
  });

  it("explains a build that cannot update itself, with no buttons that would do nothing", async () => {
    stub({ phase: "unavailable", reason: "This is a development build. Updates install in the released app." });
    await showRows();
    expect(await screen.findByText(/development build/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Check/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(button("Releases on GitHub")).toBeTruthy();
  });

  it("points a shell with no updater at the release page", async () => {
    stub({ phase: "idle" }, false);
    await showRows();
    expect(button("Releases on GitHub")).toBeTruthy();
  });

  it("can stop looking by itself", async () => {
    const { api } = stub({ phase: "idle" });
    await showRows();
    const toggle = await screen.findByRole("switch", { name: "Check for updates automatically" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(api.settingsWrite).toHaveBeenCalledWith({ updateChecks: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});

describe("the rail", () => {
  it("points at About while a release waits on the person", async () => {
    stub({ phase: "available", version: "0.9.0" });
    render(<SettingsScreen onLeave={vi.fn()} />);
    await act(async () => undefined);
    const about = screen.getByRole("button", { name: /About/ });
    await waitFor(() => expect(about.textContent).toContain("Update"));
  });

  it("says nothing when there is nothing to do", async () => {
    stub({ phase: "current", checkedAt: "2026-10-05T12:00:00.000Z" });
    render(<SettingsScreen onLeave={vi.fn()} />);
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "About" }).textContent).toBe("About");
  });
});
