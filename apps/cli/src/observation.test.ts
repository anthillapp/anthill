import { describe, expect, it, vi } from "vitest";
import { observationCommand } from "./observation.js";
import type { ObservationSetupService } from "../../desktop/src/main/live/setup.js";
import { hookPrompt } from "../../desktop/src/main/live/hook-prompt.js";

/** What the real service would ask for this harness: the same rule, not a guess. */
function withPrompt(harness: Record<string, any>) {
  return {
    ...harness,
    observationPrompt: hookPrompt({
      cliAvailable: harness.cliAvailable,
      installProblem: harness.hookInstallProblem,
      entriesPresent: harness.hookEntriesPresent,
      installed: harness.hookInstalled,
      usesCurrentRuntime: harness.hookUsesCurrentRuntime !== false,
      codexState: harness.codexHooks?.state,
      confirmedInSession: harness.codexHooks?.confirmedInSession,
      declined: harness.observationDeclined === true,
    }),
  };
}

function service(over: Record<string, unknown> = {}) {
  const harness = withPrompt({ id: "codex", cliAvailable: true, hookInstalled: false, hookEntriesPresent: false, ...over });
  const status = vi.fn(async () => ({ harnesses: [harness] }));
  const install = vi.fn(async () => ({ ok: true, status: { harnesses: [withPrompt({ ...harness, hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "needs-trust", message: "Review /hooks." } })] } }));
  const decline = vi.fn(async () => {});
  return { api: { status, install, decline } as unknown as ObservationSetupService, status, install, decline };
}

describe("plugin observation onboarding", () => {
  it("offers once without writing or installing on status", async () => {
    const fake = service();
    expect(await observationCommand("status", fake.api, "/project")).toMatchObject({ exitCode: 0, result: { offer: true, installed: false } });
    expect(fake.status).toHaveBeenCalledWith("/project", false, undefined);
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

  // ANT-138: what the agent is told to ask, in one field it acts on.
  it("asks to connect, then for trust, then nothing – and hints rather than accusing", async () => {
    expect((await observationCommand("status", service().api)).result).toMatchObject({ ask: "connect" });
    const trust = (await observationCommand("status", service({ hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "needs-trust", message: "x" } }).api)).result as any;
    expect(trust).toMatchObject({ ask: "trust", offer: false });
    expect(trust.message).toContain("Review hooks");
    expect(trust.message).toContain("Do not suggest Trust all");
    const ready = (await observationCommand("status", service({ hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "ready", message: "Ready" } }).api)).result as any;
    expect(ready.ask).toBeNull();
    const unknown = (await observationCommand("status", service({ hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "unknown", message: "Codex could not be asked." } }).api)).result as any;
    expect(unknown.ask).toBe("hint");
    expect(unknown.message).toContain("does not mean they are unapproved");
  });

  it("passes the Codex session along, so a hook that fired here settles it", async () => {
    const fake = service({ hookInstalled: true, hookEntriesPresent: true, codexHooks: { state: "ready", confirmedInSession: true, message: "Working here." } });
    vi.stubEnv("CODEX_SESSION_ID", "01a0d727-ef1b-7b20-8d10-355e4a13c67e");
    try {
      const result = (await observationCommand("status", fake.api, "/project")).result as any;
      expect(fake.status).toHaveBeenCalledWith("/project", false, "01a0d727-ef1b-7b20-8d10-355e4a13c67e");
      expect(result).toMatchObject({ ask: null, confirmedInSession: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
