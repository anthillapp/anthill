/**
 * Settings, from the author's side.
 *
 * The switch has to say what is actually stored, and it has to say what the
 * notification will be for — a setting whose wording overpromises is how
 * someone ends up believing Anthill is watching something it is not.
 *
 * The permission wording gets a test of its own because it is the one claim
 * here that could be a lie: Anthill is never told whether macOS is allowing
 * these, so Settings must not imply it knows.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsSheet } from "./SettingsSheet.js";

function stub(
  over: {
    settings?: { stepNotifications: boolean };
    probe?: { kind: "sent" } | { kind: "unsupported"; reason: string };
    failRead?: boolean;
  } = {},
) {
  let stored = over.settings ?? { stepNotifications: false };
  const settingsRead = vi.fn(async () => {
    if (over.failRead) throw new Error("unreadable");
    return stored;
  });
  const settingsWrite = vi.fn(async (patch: Partial<typeof stored>) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  const notificationsProbe = vi.fn(async () => over.probe ?? { kind: "sent" as const });
  (window as unknown as { anthill: unknown }).anthill = {
    settingsRead,
    settingsWrite,
    notificationsProbe,
    // The observation card in the second section fetches its own status.
    liveSetupStatus: vi.fn(async () => ({
      dismissed: false,
      trigger: "Shown after the first meaningful Workflow edit.",
      harnesses: [],
    })),
    liveSetupDismiss: vi.fn(async () => undefined),
  };
  return { settingsRead, settingsWrite, notificationsProbe, read: () => stored };
}

const toggle = () => screen.getByRole("checkbox") as HTMLInputElement;

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the notification setting", () => {
  it("shows what is actually stored", async () => {
    stub({ settings: { stepNotifications: true } });
    render(<SettingsSheet onClose={() => undefined} />);
    await waitFor(() => expect(toggle().checked).toBe(true));
  });

  it("is off until somebody asks for it", async () => {
    stub();
    render(<SettingsSheet onClose={() => undefined} />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });

  it("is written the moment it is changed, and reads back changed", async () => {
    const api = stub();
    render(<SettingsSheet onClose={() => undefined} />);
    await waitFor(() => expect(toggle().disabled).toBe(false));

    fireEvent.click(toggle());
    await waitFor(() => expect(api.settingsWrite).toHaveBeenCalledWith({ stepNotifications: true }));
    expect(api.read()).toEqual({ stepNotifications: true });
    await waitFor(() => expect(toggle().checked).toBe(true));
  });

  it("can be turned back off", async () => {
    const api = stub({ settings: { stepNotifications: true } });
    render(<SettingsSheet onClose={() => undefined} />);
    await waitFor(() => expect(toggle().checked).toBe(true));

    fireEvent.click(toggle());
    await waitFor(() => expect(api.read()).toEqual({ stepNotifications: false }));
    expect(toggle().checked).toBe(false);
  });

  it("says what earns a notification, in the same terms as the rest of the app", async () => {
    stub();
    render(<SettingsSheet onClose={() => undefined} />);
    const label = await screen.findByText(/reaches a new step/);
    expect(label).toBeTruthy();
    expect(screen.getByText(/confidently watching/)).toBeTruthy();
    expect(screen.getByText(/not for the same step twice/)).toBeTruthy();
  });

  it("opens on the defaults when the preferences cannot be read", async () => {
    // Settings is the only way back to a preference; it has to open.
    stub({ failRead: true });
    render(<SettingsSheet onClose={() => undefined} />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });
});

describe("what Settings says about permission", () => {
  it("does not claim to know whether macOS is allowing them", async () => {
    stub();
    render(<SettingsSheet onClose={() => undefined} />);
    expect(await screen.findByText(/It is not told when you allow or refuse them/)).toBeTruthy();
    expect(screen.getByText(/System Settings ▸ Notifications ▸ Anthill/)).toBeTruthy();
  });

  it("sends one on request, and says only that it was sent", async () => {
    const api = stub({ probe: { kind: "sent" } });
    render(<SettingsSheet onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send a test notification" }));
    await waitFor(() => expect(api.notificationsProbe).toHaveBeenCalled());
    expect(screen.getByText(/If it did not appear, macOS is holding it back/)).toBeTruthy();
  });

  it("states the one case it can know as fact", async () => {
    stub({ probe: { kind: "unsupported", reason: "This system has no notification centre." } });
    render(<SettingsSheet onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByText("This system has no notification centre.")).toBeTruthy();
  });

  it("survives a probe that never answers", async () => {
    stub();
    (window.anthill as unknown as { notificationsProbe: unknown }).notificationsProbe = vi.fn(
      async () => {
        throw new Error("gone");
      },
    );
    render(<SettingsSheet onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByText("The test could not be sent.")).toBeTruthy();
  });
});

describe("the sheet", () => {
  it("closes on Escape as well as on the button", async () => {
    stub();
    const onClose = vi.fn();
    render(<SettingsSheet onClose={onClose} />);
    await screen.findByRole("checkbox");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("is a dialog, so it is reachable and dismissible as one", async () => {
    stub();
    render(<SettingsSheet onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
