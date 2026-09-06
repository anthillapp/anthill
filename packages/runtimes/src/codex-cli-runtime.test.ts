import { describe, expect, it } from "vitest";
import { createFakeSpawn, enoent } from "./__fixtures__/fake-spawn.js";
import { CodexCliRuntime, buildCodexArgs } from "./codex-cli-runtime.js";
import type { AgentRunContext } from "./contracts.js";

function makeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runId: "run-42",
    nodeId: "node-implement",
    attempt: 2,
    workingDirectory: "/tmp/anthill-workspace",
    instructions: "Implement the parser.",
    role: "Implementer",
    ...overrides,
  };
}

describe("buildCodexArgs", () => {
  it("builds the minimal non-interactive invocation", () => {
    expect(buildCodexArgs(makeContext())).toEqual([
      "exec",
      "--cd",
      "/tmp/anthill-workspace",
      "-",
    ]);
  });

  it("includes the model when configured", () => {
    expect(buildCodexArgs(makeContext(), { model: "o4-mini" })).toEqual([
      "exec",
      "--cd",
      "/tmp/anthill-workspace",
      "--model",
      "o4-mini",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check only when opted in", () => {
    expect(buildCodexArgs(makeContext(), { skipGitRepoCheck: true })).toContain(
      "--skip-git-repo-check",
    );
    expect(buildCodexArgs(makeContext(), { skipGitRepoCheck: false })).not.toContain(
      "--skip-git-repo-check",
    );
  });

  it("appends extra args before the stdin marker", () => {
    const args = buildCodexArgs(makeContext(), { extraArgs: ["--sandbox", "read-only"] });

    expect(args.slice(-3)).toEqual(["--sandbox", "read-only", "-"]);
  });

  it("tracks the working directory from the context", () => {
    const args = buildCodexArgs(makeContext({ workingDirectory: "/srv/other" }));

    expect(args[args.indexOf("--cd") + 1]).toBe("/srv/other");
  });
});

describe("CodexCliRuntime", () => {
  it("spawns codex with the built args and the prompt envelope on stdin", async () => {
    const { spawnFn, calls } = createFakeSpawn({
      stdout: '{"status":"success","summary":"Parser implemented."}',
      exitCode: 0,
    });
    const runtime = new CodexCliRuntime({ spawnFn, model: "o4-mini" });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Parser implemented.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("codex");
    expect(calls[0]!.args).toEqual([
      "exec",
      "--cd",
      "/tmp/anthill-workspace",
      "--model",
      "o4-mini",
      "-",
    ]);
    expect(calls[0]!.options.cwd).toBe("/tmp/anthill-workspace");
    expect(calls[0]!.stdin).toContain("You are running as part of an Anthill workflow.");
    expect(calls[0]!.stdin).toContain("Implement the parser.");
    expect(raw.metadata?.runtimeId).toBe("codex-cli");
  });

  it("passes ctx.environment and configured env through to the child", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "ok" });
    const runtime = new CodexCliRuntime({ spawnFn, env: { CODEX_FLAG: "1" } });

    await runtime.run(makeContext({ environment: { ANTHILL_RUN_ID: "run-42" } }));

    expect(calls[0]!.options.env?.ANTHILL_RUN_ID).toBe("run-42");
    expect(calls[0]!.options.env?.CODEX_FLAG).toBe("1");
    // Inherited from process.env.
    expect(calls[0]!.options.env?.PATH).toBeDefined();
  });

  it("maps a non-zero exit to a failed result", async () => {
    const { spawnFn } = createFakeSpawn({
      stderr: "error: sandbox denied write access",
      exitCode: 2,
    });
    const runtime = new CodexCliRuntime({ spawnFn });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("error: sandbox denied write access");
    expect(result.metadata).toEqual({ exitCode: 2 });
    expect(raw.exitCode).toBe(2);
  });

  it("kills the process and fails on timeout", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "thinking...", neverExits: true });
    const runtime = new CodexCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext({ timeoutMs: 20 }));

    expect(result.status).toBe("failed");
    expect(result.metadata.timedOut).toBe(true);
    expect(calls[0]!.killSignals).toContain("SIGTERM");
  });

  it("reports cancellation when the AbortSignal fires mid-run", async () => {
    const { spawnFn, calls } = createFakeSpawn({ neverExits: true });
    const runtime = new CodexCliRuntime({ spawnFn });
    const controller = new AbortController();

    const pending = runtime.run(makeContext({ timeoutMs: 5_000 }), controller.signal);
    setTimeout(() => controller.abort(), 10);
    const { result } = await pending;

    expect(result.status).toBe("cancelled");
    expect(calls[0]!.killSignals).toContain("SIGTERM");
  });

  describe("detect", () => {
    it("reports the version when the binary responds", async () => {
      const { spawnFn, calls } = createFakeSpawn({ stdout: "codex-cli 0.12.3\n", exitCode: 0 });
      const runtime = new CodexCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection).toEqual({
        available: true,
        command: "codex",
        version: "codex-cli 0.12.3",
      });
      expect(calls[0]!.args).toEqual(["--version"]);
    });

    it("returns unavailable (not a throw) when the binary is absent", async () => {
      const { spawnFn } = createFakeSpawn({ spawnError: enoent("codex") });
      const runtime = new CodexCliRuntime({ spawnFn });

      await expect(runtime.detect()).resolves.toEqual({
        available: false,
        command: "codex",
        reason: "codex CLI not found on PATH",
      });
    });

    it("returns unavailable when the binary errors out", async () => {
      const { spawnFn } = createFakeSpawn({ stderr: "unknown flag --version", exitCode: 1 });
      const runtime = new CodexCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection.available).toBe(false);
      expect(detection.reason).toBe("unknown flag --version");
    });

    it("honours a custom command name", async () => {
      const { spawnFn, calls } = createFakeSpawn({ stdout: "1.0.0" });
      const runtime = new CodexCliRuntime({ spawnFn, command: "/opt/bin/codex" });

      const detection = await runtime.detect();

      expect(calls[0]!.command).toBe("/opt/bin/codex");
      expect(detection.command).toBe("/opt/bin/codex");
    });
  });
});
