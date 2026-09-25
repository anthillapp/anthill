import { describe, expect, it, vi } from "vitest";
import { observationCommand } from "./observation.js";
import type { ObservationSetupService } from "../../desktop/src/main/live/setup.js";

function service(over: Record<string, unknown> = {}) {
  const harness = { id: "codex", cliAvailable: true, hookInstalled: false, hookEntriesPresent: false, ...over };
  const status = vi.fn(async () => ({ harnesses: [harness] }));
  const install = vi.fn(async () => ({ ok: true, status: { harnesses: [{ ...harness, hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "needs-trust", message: "Review /hooks." } }] } }));
  const decline = vi.fn(async () => {});
  return { api: { status, install, decline } as unknown as ObservationSetupService, status, install, decline };
}

describe("plugin observation onboarding", () => {
  it("offers once without writing or installing on status", async () => {
    const fake = service();
    expect(await observationCommand("status", fake.api, "/project")).toMatchObject({ exitCode: 0, result: { offer: true, installed: false } });
    expect(fake.status).toHaveBeenCalledWith("/project");
    expect(fake.install).not.toHaveBeenCalled(); expect(fake.decline).not.toHaveBeenCalled();
  });
  it("installs only on enable and returns native trust as pending, not success", async () => {
    const fake = service();
    expect(await observationCommand("enable", fake.api, "/project")).toMatchObject({ result: { offer: false, installed: true, state: "needs-trust" } });
    expect(fake.install).toHaveBeenCalledWith("codex", "/project");
  });
  it("preserves a desktop-owned install and its trust hash", async () => {
    const fake = service({ hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "ready", message: "Ready" } });
    expect(await observationCommand("enable", fake.api)).toMatchObject({ result: { state: "ready", lastEventAt: null } });
    expect(fake.install).not.toHaveBeenCalled();
  });
  it("remembers a declined offer without disabling existing observation", async () => {
    const fake = service();
    expect(await observationCommand("skip", fake.api)).toMatchObject({ result: { offer: false, outcome: "skipped" } });
    expect(fake.decline).toHaveBeenCalledWith("codex");
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.status).not.toHaveBeenCalled();
    expect(await observationCommand("status", service({ observationDeclined: true }).api)).toMatchObject({ result: { offer: false } });
  });
  it("does not call trusted hooks ready when their handler is broken", async () => {
    const fake = service({ hookEntriesPresent: true, hookProblem: "Handler is missing.", codexHooks: { state: "ready", message: "Ready" } });
    expect(await observationCommand("status", fake.api)).toMatchObject({ result: { installed: false, state: "broken", message: expect.stringContaining("Handler is missing.") } });
    expect(fake.install).not.toHaveBeenCalled();
  });
  it("migrates a transient runtime only on explicit enable", async () => {
    const fake = service({ hookInstalled: true, hookEntriesPresent: true, hookUsesCurrentRuntime: false });
    await observationCommand("status", fake.api);
    expect(fake.install).not.toHaveBeenCalled();
    await observationCommand("enable", fake.api);
    expect(fake.install).toHaveBeenCalledOnce();
  });
  it("does not offer an install without a durable runtime", async () => {
    expect(await observationCommand("status", service({ hookInstallProblem: "Install the desktop." }).api)).toMatchObject({ result: { offer: false, message: "Install the desktop." } });
  });
  it("does not install for a missing CLI or an invalid command", async () => {
    const fake = service({ cliAvailable: false });
    expect((await observationCommand("enable", fake.api)).exitCode).toBe(1);
    expect(fake.install).not.toHaveBeenCalled();
    expect((await observationCommand("trust-all", fake.api)).exitCode).toBe(1);
  });
});
