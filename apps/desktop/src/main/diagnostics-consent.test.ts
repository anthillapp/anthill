import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeSettingsWithConsent, type ReportingGate } from "./diagnostics-consent.js";
import { SettingsStore } from "./settings.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "anthill-consent-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const analytics = { enable: vi.fn(async () => undefined), disable: vi.fn(async () => undefined), capture: vi.fn() };
  const gate: ReportingGate = { errors: true, nativeCrashes: true };
  return { store, analytics, gate };
}

describe("a change on the Privacy page", () => {
  it("closes the gate at once when error reports are turned off, and native dumps with them", async () => {
    const { store, analytics, gate } = await setup();
    await store.write({ errorReportingEnabled: true, nativeCrashReportingEnabled: true });
    const next = await writeSettingsWithConsent(store, analytics, gate, { errorReportingEnabled: false }, { nativeCrashes: true });
    expect(next.nativeCrashReportingEnabled).toBe(false);
    expect(gate).toEqual({ errors: false, nativeCrashes: false });
  });

  it("never stores native crash consent where there is nothing to dump", async () => {
    const { store, analytics, gate } = await setup();
    await store.write({ errorReportingEnabled: true });
    const next = await writeSettingsWithConsent(store, analytics, gate, { nativeCrashReportingEnabled: true }, { nativeCrashes: false });
    expect(next.nativeCrashReportingEnabled).toBe(false);
  });

  it("starts analytics on opt-in and drops it on opt-out", async () => {
    const { store, analytics, gate } = await setup();
    await writeSettingsWithConsent(store, analytics, gate, { analyticsEnabled: true }, { nativeCrashes: true });
    expect(analytics.enable).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenCalledWith("analytics_enabled");
    await writeSettingsWithConsent(store, analytics, gate, { analyticsEnabled: false }, { nativeCrashes: true });
    expect(analytics.disable).toHaveBeenCalledOnce();
  });
});
