/**
 * Guards on the contract itself.
 *
 * The capability check is only as good as the names it asks about: a typo in
 * the required list would make every process look out of date, and a channel
 * the page needs but never declares would put the silent failure straight back.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * Anthill designs workflows and watches sessions. It does not run them.
 *
 * The process used to be able to: `run:start` took a caller-supplied workspace
 * path, ran the engine against a shared checkout and inherited the parent
 * environment. No shipped window reached it — the renderer that did was never
 * mounted — so it was a capability with no product behind it, and a wide one
 * (ANT-95).
 *
 * This is a guard rather than a restatement. The channel list is where such a
 * thing would come back, most likely as a convenience for something else, and
 * a name is cheap to add and hard to notice. If an optional runner is ever
 * built (ANT-52) it is a deliberate product decision that changes this test on
 * purpose, not one that passes it by accident.
 */
describe("the runner that is not here", () => {
  const listed = Object.entries(IpcChannel);

  /**
   * Read as text, because the object was the wrong place to look.
   *
   * `run:event` was never an entry of `IpcChannel` — it was a standalone
   * `RUN_EVENT_CHANNEL` export beside it — so a guard that walked the object
   * could not see the push channel it named, and re-adding that channel
   * exactly as it had been would have passed. Comments come out first: a
   * guard nobody can write prose about is a guard nobody can explain.
   */
  it("offers no channel that starts or executes anything", () => {
    const source = readFileSync(resolve("src/shared/ipc.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of ["run:start", "run:cancel", "runtimes:detect", "approval:respond", "run:event"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    for (const [name, channel] of listed) {
      for (const forbidden of ["run:start", "runtimes:detect", "approval:respond", "run:event"]) {
        expect(`${name} → ${channel}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the run history channels, which are not the runner", () => {
    // The store holds what the launch window lists and the graph each Live
    // Session is drawn from. Removing these with the engine would have taken
    // the history with it.
    expect(Object.values(IpcChannel)).toContain(IpcChannel.runList);
    expect(Object.values(IpcChannel)).toContain(IpcChannel.runGet);
  });

  it("asks the user for no workspace to execute in", () => {
    // Choosing a working directory existed to give the engine somewhere to
    // run. Anthill reads and writes workflow files; it does not need a
    // checkout, and asking for one implied it would work inside it.
    const names = listed.map(([name]) => name);
    expect(names).not.toContain("workspaceSelect");
    expect(names).not.toContain("workspaceStatus");
  });
});
