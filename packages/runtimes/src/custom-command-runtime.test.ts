import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "./contracts.js";
import { CustomCommandRuntime } from "./custom-command-runtime.js";

/**
 * These tests spawn REAL subprocesses (node running the fixture scripts in
 * src/__fixtures__). Nothing about child_process is mocked here — this is the
 * end-to-end proof that spawning, stdin delivery, capture and normalization
 * all fit together.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function makeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runId: "run-1",
    nodeId: "node-review",
    attempt: 1,
    workingDirectory: repoRoot,
    instructions: "Review the package for obvious problems.",
    role: "Reviewer",
    priorResults: {
      "node-workflow": {
        status: "success",
        summary: "Planned the work.",
        artifacts: [],
        issues: [],
        metadata: {},
      },
    },
    ...overrides,
  };
}

describe("CustomCommandRuntime (real subprocess)", () => {
  it("runs a JSON-emitting command and returns the parsed AgentResult", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("json-agent.mjs")],
      outputMode: "json",
    });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Reviewed the workspace and made no changes.");
    expect(result.decision).toBe("approve");
    expect(result.artifacts).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      severity: "low",
      title: "Missing README section",
      file: "README.md",
    });
    expect(raw.exitCode).toBe(0);
    // The fixture echoes back what it saw: proves the envelope reached stdin
    // and that the child ran in ctx.workingDirectory.
    expect(result.metadata.sawRole).toBe(true);
    expect(result.metrics?.promptLength).toBeGreaterThan(100);
    expect(result.metadata.cwd).toBe(repoRoot.replace(/\/$/, ""));
    expect(raw.metadata?.promptDelivery).toBe("stdin");
  });

  it("falls back to a text summary when the command prints no JSON", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("text-agent.mjs")],
      outputMode: "json",
    });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary).toMatch(/^I read a prompt of \d+ characters and did the thing\.$/);
    expect(result.metadata).toEqual({ rawStdoutTruncated: false });
  });

  it("does not parse JSON when outputMode is text", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("json-agent.mjs")],
      outputMode: "text",
    });

    const { result } = await runtime.run(makeContext());

    expect(result.status).toBe("success");
    expect(result.summary.startsWith("[json-agent] warming up...")).toBe(true);
    expect(result.decision).toBeUndefined();
    expect(result.artifacts).toEqual([]);
    expect(typeof result.metadata.rawStdoutTruncated).toBe("boolean");
  });

  it("reports a failing command as failed with stderr and the exit code", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("failing-agent.mjs")],
      outputMode: "json",
    });

    const { result, raw } = await runtime.run(makeContext());

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("fatal: could not reach the model endpoint");
    expect(result.metadata).toEqual({ exitCode: 3 });
    expect(raw.exitCode).toBe(3);
  });

  it("kills and fails a command that exceeds ctx.timeoutMs", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("hanging-agent.mjs")],
      outputMode: "json",
    });

    const { result } = await runtime.run(makeContext({ timeoutMs: 150 }));

    expect(result.status).toBe("failed");
    expect(result.metadata.timedOut).toBe(true);
  }, 15_000);

  it("reports cancellation when the AbortSignal fires", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("hanging-agent.mjs")],
      outputMode: "json",
    });

    const controller = new AbortController();
    const pending = runtime.run(makeContext({ timeoutMs: 10_000 }), controller.signal);
    setTimeout(() => controller.abort(), 100);

    const { result } = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.metadata.cancelled).toBe(true);
  }, 15_000);

  it("returns cancelled immediately for an already-aborted signal", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [fixture("json-agent.mjs")],
      outputMode: "json",
    });

    const { result } = await runtime.run(makeContext(), AbortSignal.abort());

    expect(result.status).toBe("cancelled");
  });

  it("detects an available command via --version", async () => {
    const runtime = new CustomCommandRuntime({
      command: process.execPath,
      args: [],
      outputMode: "json",
    });

    const detection = await runtime.detect();

    expect(detection.available).toBe(true);
    expect(detection.version).toMatch(/^v\d+\./);
  });

  it("reports a missing command as unavailable instead of throwing", async () => {
    const runtime = new CustomCommandRuntime({
      command: "anthill-definitely-not-a-real-binary",
      args: [],
      outputMode: "json",
    });

    const detection = await runtime.detect();

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain("not found on PATH");
  });
});
