import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAnalytics } from "./analytics.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("optional desktop analytics", () => {
  it("does nothing on an unavailable build, even if consent is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-analytics-"));
    dirs.push(dir);
    const makeClient = vi.fn();
    const analytics = new DesktopAnalytics(dir, false, makeClient);
    await analytics.enable();
    analytics.capture("desktop_opened");
    expect(makeClient).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "analytics-id"), "utf8")).rejects.toThrow();
  });

  it("sends only an allowlisted event and rotates the identifier after opt-out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-analytics-"));
    dirs.push(dir);
    const captureImmediate = vi.fn(async () => undefined);
    const disable = vi.fn(async () => undefined);
    const analytics = new DesktopAnalytics(dir, true, () => ({ captureImmediate, disable }));
    analytics.capture("desktop_opened");
    expect(captureImmediate).not.toHaveBeenCalled();

    await analytics.enable();
    const first = await readFile(join(dir, "analytics-id"), "utf8");
    analytics.capture("workflow_saved");
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: first,
      event: "workflow_saved",
      disableGeoip: true,
    });

    await analytics.disable();
    analytics.capture("desktop_opened");
    expect(captureImmediate).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledOnce();
    await expect(readFile(join(dir, "analytics-id"), "utf8")).rejects.toThrow();

    await analytics.enable();
    expect(await readFile(join(dir, "analytics-id"), "utf8")).not.toBe(first);
  });
});
