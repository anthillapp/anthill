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

/** A settled RPC run: the assistant's final message, then the ending record. */
function settledRun(text: string, stopReason: "stop" | "error" = "stop", errorMessage?: string): string {
  const message = {
    role: "assistant",
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    content: [{ type: "text", text }],
  };
  return [
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    JSON.stringify({ type: "message_end", message }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "agent_end", willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n") + "\n";
}

describe("buildPiArgs", () => {
  it("builds the minimal RPC-mode invocation", () => {
    // `--mode rpc` is pi's programmatic interface: the prompt goes in as a
    // JSON `prompt` command on stdin, so no prompt argument appears here.
    expect(buildPiArgs(makeContext())).toEqual(["--mode", "rpc"]);
  });

  it("includes the model when configured", () => {
    expect(buildPiArgs(makeContext(), { model: "anthropic/claude-sonnet-4-5" })).toEqual([
      "--mode",
      "rpc",
      "--model",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("includes the thinking level when configured", () => {
    expect(buildPiArgs(makeContext(), { thinking: "high" })).toEqual([
      "--mode",
      "rpc",
      "--thinking",
      "high",
    ]);
  });

  it("appends extra args after the fixed ones", () => {
    const args = buildPiArgs(makeContext(), { extraArgs: ["--no-extensions"] });
    expect(args).toEqual(["--mode", "rpc", "--no-extensions"]);
  });
});

describe("PiCliRuntime", () => {
  it("spawns pi in RPC mode and sends the prompt envelope as the prompt command", async () => {
    const { spawnFn, calls } = createFakeSpawn({
      stdout: settledRun("Parser implemented."),
      neverExits: true,
    });
    const runtime = new PiCliRuntime({ spawnFn, model: "anthropic/claude-sonnet-4-5" });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Parser implemented.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("pi");
    expect(calls[0]!.args).toEqual(["--mode", "rpc", "--model", "anthropic/claude-sonnet-4-5"]);
    expect(calls[0]!.options.cwd).toBe("/tmp/anthill-workspace");
    // The envelope travels as the JSON `prompt` command, not as a raw stdin payload.
    expect(calls[0]!.stdin).toContain('"type":"prompt"');
    expect(calls[0]!.stdin).toContain("You are running as part of an Anthill workflow.");
    expect(calls[0]!.stdin).toContain("Implement the parser.");
    // The run settled on `agent_settled`, so the adapter ended the child.
    expect(calls[0]!.killSignals).toContain("SIGTERM");
    expect(raw.metadata?.runtimeId).toBe("pi-cli");
    expect(raw.metadata?.promptDelivery).toBe("rpc-prompt-command");
  });

  it("passes ctx.environment and configured env through to the child", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: settledRun("ok"), neverExits: true });
    const runtime = new PiCliRuntime({ spawnFn, env: { PI_FLAG: "1" } });

    await runtime.run(makeContext({ environment: { ANTHILL_RUN_ID: "run-42" } }));

    expect(calls[0]!.options.env?.ANTHILL_RUN_ID).toBe("run-42");
    expect(calls[0]!.options.env?.PI_FLAG).toBe("1");
    // Inherited from process.env.
    expect(calls[0]!.options.env?.PATH).toBeDefined();
  });

  it("maps a run that ended in an error to a failed result", async () => {
    const { spawnFn } = createFakeSpawn({
      stdout: settledRun("", "error", "no provider configured"),
      neverExits: true,
    });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("no provider configured");
    expect(raw.exitCode).toBe(1);
  });

  it("maps a rejected prompt command to a failed result", async () => {
    const { spawnFn } = createFakeSpawn({
      stdout: JSON.stringify({ type: "response", id: 1, command: "prompt", success: false, error: "invalid model" }) + "\n",
      neverExits: true,
    });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("invalid model");
  });

  it("maps a run that ended aborted to a cancelled result", async () => {
    const { spawnFn } = createFakeSpawn({
      stdout: settledRun("", "aborted"),
      neverExits: true,
    });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("cancelled");
  });

  it("kills the process and fails on timeout", async () => {
    // The stream speaks but never settles: the run is still going when the
    // time budget runs out.
    const { spawnFn, calls } = createFakeSpawn({
      stdout: JSON.stringify({ type: "agent_start" }),
      neverExits: true,
    });
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

  it("fails cleanly when the child dies before the run settles", async () => {
    const { spawnFn } = createFakeSpawn({
      stderr: "fatal: model provider crashed",
      exitCode: 1,
    });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("fatal: model provider crashed");
  });

  it("fails cleanly when the binary is missing", async () => {
    const { spawnFn } = createFakeSpawn({ spawnError: enoent("pi") });
    const runtime = new PiCliRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("ENOENT");
  });

  describe("detect", () => {
    it("reports the version when the binary responds", async () => {
      const { spawnFn, calls } = createFakeSpawn({ stdout: "0.85.1\n", exitCode: 0 });
      const runtime = new PiCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection).toEqual({
        available: true,
        version: "0.85.1",
        command: "pi",
      });
      expect(calls[0]!.args).toEqual(["--version"]);
    });

    it("reports unavailable when the binary is missing", async () => {
      const { spawnFn } = createFakeSpawn({ spawnError: enoent("pi") });
      const runtime = new PiCliRuntime({ spawnFn });

      const detection = await runtime.detect();

      expect(detection.available).toBe(false);
      expect(detection.reason).toBe("pi CLI not found on PATH");
    });
  });
});
