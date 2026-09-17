import { describe, expect, it } from "vitest";
import { createFakeSpawn, enoent } from "./__fixtures__/fake-spawn.js";
import { PiCliRuntime, buildPiArgs } from "./pi-cli-runtime.js";
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

describe("buildPiArgs", () => {
  it("builds the minimal non-interactive invocation", () => {
    // `-p` is print mode: process the prompt and exit. The prompt itself is
    // piped in on stdin, so no prompt argument appears here.
    expect(buildPiArgs(makeContext())).toEqual(["-p"]);
  });

  it("includes the model when configured", () => {
    expect(buildPiArgs(makeContext(), { model: "anthropic/claude-sonnet-4-5" })).toEqual([
      "-p",
      "--model",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("includes the thinking level when configured", () => {
    expect(buildPiArgs(makeContext(), { thinking: "high" })).toEqual([
      "-p",
      "--thinking",
      "high",
    ]);
  });

  it("appends extra args after the fixed ones", () => {
    const args = buildPiArgs(makeContext(), { extraArgs: ["--no-extensions"] });
    expect(args).toEqual(["-p", "--no-extensions"]);
  });
});

describe("PiCliRuntime", () => {
  it("spawns pi with the built args and the prompt envelope on stdin", async () => {
    const { spawnFn, calls } = createFakeSpawn({
      stdout: '{"status":"success","summary":"Parser implemented."}',
      exitCode: 0,
    });
    const runtime = new PiCliRuntime({ spawnFn, model: "anthropic/claude-sonnet-4-5" });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Parser implemented.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("pi");
    expect(calls[0]!.args).toEqual([
      "-p",
      "--model",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(calls[0]!.options.cwd).toBe("/tmp/anthill-workspace");
    expect(calls[0]!.stdin).toContain("You are running as part of an Anthill workflow.");
    expect(calls[0]!.stdin).toContain("Implement the parser.");
    expect(raw.metadata?.runtimeId).toBe("pi-cli");
  });

  it("passes ctx.environment and configured env through to the child", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "ok" });
    const runtime = new PiCliRuntime({ spawnFn, env: { PI_FLAG: "1" } });

    await runtime.run(makeContext({ environment: { ANTHILL_RUN_ID: "run-42" } }));

    expect(calls[0]!.options.env?.ANTHILL_RUN_ID).toBe("run-42");
    expect(calls[0]!.options.env?.PI_FLAG).toBe("1");
    // Inherited from process.env.
    expect(calls[0]!.options.env?.PATH).toBeDefined();
  });

  it("maps a non-zero exit to a failed result", async () => {
    const { spawnFn } = createFakeSpawn({
      stderr: "error: no provider configured",
      exitCode: 1,
    });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("error: no provider configured");
    expect(result.metadata).toEqual({ exitCode: 1 });
    expect(raw.exitCode).toBe(1);
  });

  it("kills the process and fails on timeout", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "thinking...", neverExits: true });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext({ timeoutMs: 20 }));

    expect(result.status).toBe("failed");
    expect(result.metadata.timedOut).toBe(true);
    expect(calls[0]!.killSignals).toContain("SIGTERM");
  });

  it("reports cancellation when the AbortSignal fires mid-run", async () => {
    const { spawnFn, calls } = createFakeSpawn({ neverExits: true });
    const runtime = new PiCliRuntime({ spawnFn });
    const controller = new AbortController();

    const pending = runtime.run(makeContext({ timeoutMs: 5_000 }), controller.signal);
    setTimeout(() => controller.abort(), 10);
    const { result } = await pending;

    expect(result.status).toBe("cancelled");
    expect(calls[0]!.killSignals).toContain("SIGTERM");
  });

  describe("detect", () => {
    it("reports the version when the binary responds", async () => {
      const { spawnFn, calls } = createFakeSpawn({ stdout: "0.85.1\n", exitCode: 0 });
      const runtime = new PiCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection).toEqual({
        available: true,
        command: "pi",
        version: "0.85.1",
      });
      expect(calls[0]!.args).toEqual(["--version"]);
    });

    it("returns unavailable (not a throw) when the binary is absent", async () => {
      const { spawnFn } = createFakeSpawn({ spawnError: enoent("pi") });
      const runtime = new PiCliRuntime({ spawnFn });

      await expect(runtime.detect()).resolves.toEqual({
        available: false,
        command: "pi",
        reason: "pi CLI not found on PATH",
      });
    });

    it("returns unavailable when the binary errors out", async () => {
      const { spawnFn } = createFakeSpawn({ stderr: "unknown flag --version", exitCode: 1 });
      const runtime = new PiCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection.available).toBe(false);
      expect(detection.reason).toBe("unknown flag --version");
    });

    it("honours a custom command name", async () => {
      const { spawnFn, calls } = createFakeSpawn({ stdout: "0.85.1" });
      const runtime = new PiCliRuntime({ spawnFn, command: "/opt/bin/pi" });

      const detection = await runtime.detect();

      expect(calls[0]!.command).toBe("/opt/bin/pi");
      expect(detection.command).toBe("/opt/bin/pi");
    });
  });
});
