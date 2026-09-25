import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "@anthill/runtimes";
import { classifyCodexHooks, readCodexHookStatus } from "./codex-hook-status.js";

const expected = {
  configPath: "/home/user/.codex/hooks.json", cwd: "/project",
  commands: [{ command: "anthill SessionStart", event: "SessionStart" }, { command: "anthill PostToolUse", event: "PostToolUse" }],
};
function listing(over: Record<string, unknown> = {}) {
  return { data: [{ cwd: expected.cwd, errors: [], warnings: [], hooks: expected.commands.map(({ command, event }) => ({
    command, eventName: event[0].toLowerCase() + event.slice(1), sourcePath: expected.configPath,
    enabled: true, trustStatus: "trusted", ...over,
  })) }] };
}
const config = { config: {} };
const policy = { requirements: null };

describe("Codex permission diagnosis", () => {
  it("matches a canonical hook source through a symlinked configuration directory", () => {
    const root = mkdtempSync(join(tmpdir(), "anthill-hook-path-"));
    try {
      const configPath = join(root, "hooks.json");
      writeFileSync(configPath, "{}");
      const alias = join(root, "alias.json");
      symlinkSync(configPath, alias);
      expect(classifyCodexHooks(listing({ sourcePath: configPath, trustStatus: "untrusted" }), config, policy, { ...expected, configPath: alias }).state).toBe("needs-trust");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("requires trust for every expected hook, including changed definitions", () => {
    for (const trustStatus of ["untrusted", "modified"]) {
      const data = listing(); data.data[0].hooks[1].trustStatus = trustStatus;
      expect(classifyCodexHooks(data, config, policy, expected).state).toBe("needs-trust");
    }
  });
  it("is ready only when all exact commands are loaded, enabled and trusted", () => {
    expect(classifyCodexHooks(listing(), config, policy, expected).state).toBe("ready");
    expect(classifyCodexHooks(listing({ enabled: false }), config, policy, expected).state).toBe("disabled");
    expect(classifyCodexHooks(listing({ command: "other hook anthill" }), config, policy, expected).state).toBe("not-loaded");
    expect(classifyCodexHooks(listing({ sourcePath: "/different/hooks.json" }), config, policy, expected).state).toBe("not-loaded");
    expect(classifyCodexHooks(listing({ trustStatus: "future-value" }), config, policy, expected).state).toBe("unknown");
    expect(classifyCodexHooks(listing(), config, policy, { ...expected, commands: [] }).state).toBe("not-loaded");
  });
  it("detects global settings and policy even if individual hooks look ready", () => {
    expect(classifyCodexHooks(listing(), { config: { features: { hooks: false } } }, policy, expected).state).toBe("disabled");
    expect(classifyCodexHooks(listing(), { config: { features: { codex_hooks: false } } }, policy, expected).state).toBe("disabled");
    expect(classifyCodexHooks(listing(), config, { requirements: { allowManagedHooksOnly: true } }, expected).state).toBe("disabled");
    expect(classifyCodexHooks(listing(), config, { requirements: { featureRequirements: { hooks: false } } }, expected).state).toBe("disabled");
    expect(classifyCodexHooks(listing(), { config: { features: { hooks: false } } }, { requirements: { featureRequirements: { hooks: true } } }, expected).state).toBe("ready");
  });
  it("does not guess after parse errors or a response for another project", () => {
    const data = listing(); (data.data[0].errors as unknown[]).push({ message: "bad hooks.json" });
    expect(classifyCodexHooks(data, config, policy, expected).state).toBe("unknown");
    expect(classifyCodexHooks(listing(), {}, policy, expected).state).toBe("unknown");
    expect(classifyCodexHooks(listing(), config, policy, { ...expected, cwd: "/other" }).state).toBe("unknown");
  });
});

function transport(mode: "ok" | "unsupported" | "close" | "hang" | "malformed" | "flood" | "aux-missing" | "aux-hang" = "ok") {
  const child = new EventEmitter();
  const stdout = new EventEmitter(); const stderr = new EventEmitter(); const stdin = new EventEmitter();
  const messages: any[] = [];
  const kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 0)); });
  Object.assign(stdin, { end: vi.fn(), write(line: string) {
    const request = JSON.parse(line); messages.push(request);
    queueMicrotask(() => {
      if (mode === "hang") return;
      if (mode === "close") { stderr.emit("data", "failed to initialize sqlite state"); child.emit("close", 1); return; }
      if (mode === "malformed") { stdout.emit("data", "garbage\n"); return; }
      if (mode === "flood") { stdout.emit("data", "x".repeat(1024 * 1024 + 1)); return; }
      if (!request.id) return;
      if (mode === "aux-hang" && request.id > 2) return;
      const result = request.id === 1 ? {} : request.id === 2 ? listing() : request.id === 3 ? config : policy;
      const response = (mode === "unsupported" && request.id === 2) || (mode === "aux-missing" && request.id > 2)
        ? { id: request.id, error: { code: -32601 } } : { id: request.id, result };
      const encoded = JSON.stringify(response) + "\n";
      stdout.emit("data", encoded.slice(0, 13)); stdout.emit("data", encoded.slice(13));
    });
  } });
  const spawnFn: SpawnFn = vi.fn(() => Object.assign(child, { stdout, stderr, stdin, kill })) as unknown as SpawnFn;
  return { spawnFn, messages, kill };
}

describe("read-only Codex app-server client", () => {
  it("handshakes, reads effective project config, and closes without starting a session", async () => {
    const fake = transport();
    expect((await readCodexHookStatus({ ...expected, spawnFn: fake.spawnFn })).state).toBe("ready");
    expect(fake.messages.map((m) => m.method)).toEqual(["initialize", "initialized", "hooks/list", "config/read", "configRequirements/read"]);
    expect(fake.messages[2].params.cwds).toEqual(["/project"]);
    expect(fake.messages[3].params.cwd).toBe("/project");
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it.each(["unsupported", "close", "malformed", "flood"] as const)("falls back honestly on %s", async (mode) => {
    expect((await readCodexHookStatus({ ...expected, spawnFn: transport(mode).spawnFn })).state).toBe("unknown");
  });
  it("keeps trust diagnosis when auxiliary APIs are unavailable", async () => {
    const untrusted = listing({ trustStatus: "untrusted" });
    expect(classifyCodexHooks(untrusted, {}, {}, expected).state).toBe("needs-trust");
    const result = await readCodexHookStatus({ ...expected, spawnFn: transport("aux-missing").spawnFn });
    expect(result.state).toBe("unknown");
    expect(result.message).toContain("confirms Anthill’s hooks are trusted");
    expect(result.message).toContain("configRequirements/read");
    expect((await readCodexHookStatus({ ...expected, spawnFn: transport("aux-hang").spawnFn, timeoutMs: 10 })).message).toContain("trusted");
  });
  it("distinguishes a changed event schema from hooks not loading", () => {
    expect(classifyCodexHooks(listing({ eventName: "future-schema" }), config, policy, expected).message).toContain("unfamiliar event format");
    const pascal = listing();
    pascal.data[0].hooks.forEach((hook, i) => { hook.eventName = expected.commands[i].event; });
    expect(classifyCodexHooks(pascal, config, policy, expected).state).toBe("ready");
  });
  it("reports a sandbox access failure as a structured retry, not success", async () => {
    expect(await readCodexHookStatus({ ...expected, spawnFn: transport("close").spawnFn })).toMatchObject({ state: "unknown", requiresHostAccess: true });
  });
  it("bounds a hung server and kills it", async () => {
    const fake = transport("hang");
    expect((await readCodexHookStatus({ ...expected, spawnFn: fake.spawnFn, timeoutMs: 10 })).state).toBe("unknown");
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
