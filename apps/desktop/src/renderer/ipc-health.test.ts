/**
 * Every way the three halves of Anthill can be out of step with each other.
 *
 * Each of these used to be the same thing on screen — nothing — and the point
 * of the module under test is that they are now different answers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC_CONTRACT } from "../shared/ipc.js";
import { checkIpcHealth } from "./ipc-health.js";

const REQUIRED = ["live:snapshot", "live:events"];

function bridge(api: Record<string, unknown> | undefined) {
  if (api === undefined) delete (window as unknown as { anthill?: unknown }).anthill;
  else (window as unknown as { anthill: unknown }).anthill = api;
}

afterEach(() => {
  bridge(undefined);
});

describe("checking the process behind the screen", () => {
  it("passes when everything required is served", async () => {
    bridge({
      contract: IPC_CONTRACT,
      capabilities: vi.fn(async () => ({
        contract: IPC_CONTRACT,
        channels: [...REQUIRED, "app:relaunch"],
      })),
    });

    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "ok", canRelaunch: true });
  });

  it("reports a missing bridge when no preload ran at all", async () => {
    bridge(undefined);
    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "stale", side: "bridge", canRelaunch: false });
    expect((health as { detail: string }).detail).toContain("open it again");
  });

  it("reports a preload older than the renderer, without invoking anything", async () => {
    const capabilities = vi.fn();
    bridge({ contract: 1 });

    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "stale", side: "preload" });
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("reports a main process that never registered the handshake", async () => {
    // Exactly what Electron does for an unregistered channel.
    bridge({
      contract: IPC_CONTRACT,
      capabilities: vi.fn(async () => {
        throw new Error("No handler registered for 'app:capabilities'");
      }),
    });

    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "stale", side: "main", canRelaunch: false });
    expect((health as { detail: string }).detail).toContain(
      "Live Session needs an Anthill restart",
    );
  });

  it("names the channels a running main process is missing", async () => {
    bridge({
      contract: IPC_CONTRACT,
      capabilities: vi.fn(async () => ({
        contract: IPC_CONTRACT,
        channels: ["live:snapshot", "app:relaunch"],
      })),
    });

    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "stale", side: "main", missing: ["live:events"] });
    // Main answers the restart channel, so the recovery can be offered.
    expect((health as { canRelaunch: boolean }).canRelaunch).toBe(true);
  });

  it("rejects a main process on an older contract even with the channels present", async () => {
    bridge({
      contract: IPC_CONTRACT,
      capabilities: vi.fn(async () => ({ contract: IPC_CONTRACT - 1, channels: REQUIRED })),
    });

    const health = await checkIpcHealth(REQUIRED);
    expect(health).toMatchObject({ status: "stale", side: "main" });
  });

  it("does not offer a restart the running process cannot perform", async () => {
    bridge({
      contract: IPC_CONTRACT,
      capabilities: vi.fn(async () => ({ contract: IPC_CONTRACT, channels: ["live:snapshot"] })),
    });

    const health = await checkIpcHealth(REQUIRED);
    expect((health as { canRelaunch: boolean }).canRelaunch).toBe(false);
  });
});
