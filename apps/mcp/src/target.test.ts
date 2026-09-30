/**
 * Pointing the server at the development build: where that is said, whether
 * the build is running, and what a handover then reports.
 */

import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appRunning, devLauncher, readTargetSetting } from "./target.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "anthill-target-"));
}

describe("the target the settings file names", () => {
  it("is the development build when it says dev", async () => {
    const file = join(await dir(), "plugin.json");
    await writeFile(file, JSON.stringify({ server: "/abs/server.js", target: "dev" }));
    expect(readTargetSetting(file)).toBe("dev");
  });

  it("is said by nothing else: a missing file, a damaged one, or another word", async () => {
    const root = await dir();
    expect(readTargetSetting(join(root, "missing.json"))).toBeUndefined();
    await writeFile(join(root, "broken.json"), "{");
    expect(readTargetSetting(join(root, "broken.json"))).toBeUndefined();
    await writeFile(join(root, "other.json"), JSON.stringify({ target: "staging" }));
    expect(readTargetSetting(join(root, "other.json"))).toBeUndefined();
  });
});

describe("whether a build is running on a data directory", () => {
  it("is running when its lock names a live process", async () => {
    const root = await dir();
    await symlink(`this-host-${process.pid}`, join(root, "SingletonLock"));
    expect(appRunning(root)).toBe(true);
  });

  it("is not running with no lock, or a lock a crash left behind", async () => {
    expect(appRunning(await dir())).toBe(false);
    const root = await dir();
    await symlink("this-host-999999999", join(root, "SingletonLock"));
    expect(appRunning(root)).toBe(false);
  });
});

describe("a handover to the development build", () => {
  const url = "anthill://workflow/w1";

  it("opens nothing and says the running build shows it", async () => {
    const report = await devLauncher("/dev-data", () => true)(url);
    expect(report.outcome).toBe("dev");
    expect(report.message).toContain("is running");
  });

  it("says how to start the build when it is not running", async () => {
    const report = await devLauncher("/dev-data", () => false)(url);
    expect(report.outcome).toBe("dev");
    expect(report.message).toContain("npm run dev:desktop");
    expect(report.message).toContain(url);
  });
});
