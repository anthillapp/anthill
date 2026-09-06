import { describe, expect, it } from "vitest";
import { createFakeSpawn, enoent } from "./__fixtures__/fake-spawn.js";
import { ClaudeCodeRuntime, buildClaudeArgs } from "./claude-code-runtime.js";
import type { AgentRunContext } from "./contracts.js";

function makeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runId: "run-7",
    nodeId: "node-review",
    attempt: 1,
    workingDirectory: "/tmp/anthill-workspace",
    instructions: "Review the diff for regressions.",
    role: "Reviewer",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  it("builds the minimal headless invocation", () => {
    expect(buildClaudeArgs(makeContext())).toEqual(["-p", "--output-format", "text"]);
  });

  it("includes model and permission mode when configured", () => {
    expect(
      buildClaudeArgs(makeContext(), { model: "sonnet", permissionMode: "acceptEdits" }),
    ).toEqual([
      "-p",
      "--output-format",
      "text",
      "--model",
      "sonnet",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("appends extra args last", () => {
    const args = buildClaudeArgs(makeContext(), { extraArgs: ["--add-dir", "/srv/shared"] });

    expect(args.slice(-2)).toEqual(["--add-dir", "/srv/shared"]);
  });

  it("never selects the json output format (it would hide the agent's own JSON)", () => {
    expect(buildClaudeArgs(makeContext())).not.toContain("json");
  });
});

describe("ClaudeCodeRuntime", () => {
  it("spawns claude with the built args and the prompt envelope on stdin", async () => {
    const { spawnFn, calls } = createFakeSpawn({
      stdout: 'Here you go:\n{"status":"success","summary":"No regressions found."}\n',
    });
    const runtime = new ClaudeCodeRuntime({ spawnFn });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("No regressions found.");
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.args).toEqual(["-p", "--output-format", "text"]);
    expect(calls[0]!.options.cwd).toBe("/tmp/anthill-workspace");
    expect(calls[0]!.stdin).toContain("Review the diff for regressions.");
    expect(calls[0]!.stdin).toContain("Reviewer");
    expect(raw.metadata?.runtimeId).toBe("claude-code-cli");
    expect(raw.metadata?.promptDelivery).toBe("stdin");
  });

  it("falls back to a text summary when the CLI prints prose", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: "I looked at the diff and it seems fine.\n" });
    const runtime = new ClaudeCodeRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("I looked at the diff and it seems fine.");
    expect(result.metadata).toEqual({ rawStdoutTruncated: false });
  });

  it("maps a non-zero exit to a failed result", async () => {
    const { spawnFn } = createFakeSpawn({ stderr: "Credit balance too low", exitCode: 1 });
    const runtime = new ClaudeCodeRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Credit balance too low");
    expect(result.metadata).toEqual({ exitCode: 1 });
  });

  it("kills the process and fails on timeout", async () => {
    const { spawnFn, calls } = createFakeSpawn({ neverExits: true });
    const runtime = new ClaudeCodeRuntime({ spawnFn });

    const { result } = await runtime.run(makeContext({ timeoutMs: 20 }));

    expect(result.status).toBe("failed");
    expect(result.metadata.timedOut).toBe(true);
    expect(calls[0]!.killSignals[0]).toBe("SIGTERM");
  });

  it("reports cancellation when the AbortSignal fires mid-run", async () => {
    const { spawnFn } = createFakeSpawn({ neverExits: true });
    const runtime = new ClaudeCodeRuntime({ spawnFn });
    const controller = new AbortController();

    const pending = runtime.run(makeContext({ timeoutMs: 5_000 }), controller.signal);
    setTimeout(() => controller.abort(), 10);

    expect((await pending).result.status).toBe("cancelled");
  });

  describe("detect", () => {
    it("reports the version when the binary responds", async () => {
      const { spawnFn } = createFakeSpawn({ stdout: "2.0.1 (Claude Code)\n" });
      const runtime = new ClaudeCodeRuntime({ spawnFn });

      await expect(runtime.detect()).resolves.toEqual({
        available: true,
        command: "claude",
        version: "2.0.1 (Claude Code)",
      });
    });

    it("returns unavailable (not a throw) when the binary is absent", async () => {
      const { spawnFn } = createFakeSpawn({ spawnError: enoent("claude") });
      const runtime = new ClaudeCodeRuntime({ spawnFn });

      await expect(runtime.detect()).resolves.toEqual({
        available: false,
        command: "claude",
        reason: "claude CLI not found on PATH",
      });
    });
  });
});
