import { describe, expect, it } from "vitest";
import { createFakeSpawn, enoent } from "./__fixtures__/fake-spawn.js";
import { runProcess, type SpawnFn } from "./process-runner.js";

describe("runProcess", () => {
  it("collects stdout, stderr and the exit code", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "out", stderr: "err", exitCode: 0 });

    const outcome = await runProcess({
      command: "thing",
      args: ["--flag"],
      cwd: "/work",
      stdinPayload: "hello",
      timeoutMs: 1_000,
      spawnFn,
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      cancelled: false,
    });
    expect(calls[0]!.stdin).toBe("hello");
    expect(calls[0]!.options.cwd).toBe("/work");
  });

  it("reports a spawn error instead of rejecting", async () => {
    const { spawnFn } = createFakeSpawn({ spawnError: enoent("thing") });

    const outcome = await runProcess({ command: "thing", args: [], timeoutMs: 1_000, spawnFn });

    expect(outcome.exitCode).toBeNull();
    expect(outcome.spawnError?.code).toBe("ENOENT");
    expect(outcome.stderr).toContain("ENOENT");
  });

  it("reports a synchronous spawn throw instead of rejecting", async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error("EPERM: operation not permitted");
    };

    const outcome = await runProcess({ command: "thing", args: [], timeoutMs: 1_000, spawnFn });

    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderr).toContain("EPERM");
  });

  it("escalates to SIGKILL and still resolves when a process ignores SIGTERM", async () => {
    const { spawnFn, calls } = createFakeSpawn({ neverExits: true, ignoreKill: true });

    const outcome = await runProcess({
      command: "stubborn",
      args: [],
      timeoutMs: 10,
      spawnFn,
      killGraceMs: 10,
      forceResolveMs: 10,
    });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(calls[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("short-circuits when the signal is already aborted", async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: "never runs" });

    const outcome = await runProcess({
      command: "thing",
      args: [],
      timeoutMs: 1_000,
      spawnFn,
      signal: AbortSignal.abort(),
    });

    expect(outcome.cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not time out when timeoutMs is zero or infinite", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: "quick", exitCode: 0 });

    const outcome = await runProcess({ command: "thing", args: [], timeoutMs: 0, spawnFn });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
  });
});

/**
 * The output hook: a liveness signal for callers who need to know the process
 * is speaking before the collected outcome lands.
 */
describe("onOutput", () => {
  it("reports each stream's chunks as they arrive, and still collects them", async () => {
    const heard: [string, string][] = [];
    const outcome = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('answer'); process.stderr.write('aside');"],
      timeoutMs: 5_000,
      onOutput: (stream, chunk) => heard.push([stream, chunk]),
    });
    expect(outcome.stdout).toBe("answer");
    expect(outcome.stderr).toBe("aside");
    expect(heard).toContainEqual(["stdout", "answer"]);
    expect(heard).toContainEqual(["stderr", "aside"]);
  });
});
