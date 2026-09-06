/**
 * Guards on the contract itself.
 *
 * The capability check is only as good as the names it asks about: a typo in
 * the required list would make every process look out of date, and a channel
 * the page needs but never declares would put the silent failure straight back.
 */

import { describe, expect, it } from "vitest";

import { IPC_CONTRACT, IpcChannel, LIVE_SESSION_CHANNELS } from "./ipc.js";

describe("the IPC contract", () => {
  it("only requires channels that exist in the contract", () => {
    const known = new Set<string>(Object.values(IpcChannel));
    for (const channel of LIVE_SESSION_CHANNELS) expect(known.has(channel)).toBe(true);
  });

  it("requires the channels the Live Session page actually uses", () => {
    // Both, and not just the one that happened to be added last: the page reads
    // the run from the snapshot and its activity from the events channel.
    expect(LIVE_SESSION_CHANNELS).toContain(IpcChannel.liveSnapshot);
    expect(LIVE_SESSION_CHANNELS).toContain(IpcChannel.liveEvents);
  });

  it("carries a contract number a process can be compared against", () => {
    expect(Number.isInteger(IPC_CONTRACT)).toBe(true);
    expect(IPC_CONTRACT).toBeGreaterThan(0);
  });

  it("names the handshake and the recovery as ordinary channels", () => {
    expect(IpcChannel.appCapabilities).toBe("app:capabilities");
    expect(IpcChannel.appRelaunch).toBe("app:relaunch");
  });
});
