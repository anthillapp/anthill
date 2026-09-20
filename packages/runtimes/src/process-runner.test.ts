import { describe, expect, it } from "vitest";
import { createFakeSpawn, enoent } from "./__fixtures__/fake-spawn.js";
import { MAX_CAPTURED_OUTPUT, runProcess, type SpawnFn } from "./process-runner.js";

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

/**
 * A child that writes without stopping must not take the process with it
 * (ANT-99).
 *
 * These two strings grew for as long as the child wrote, and every caller in
 * the app shares them: CLI detection, model probes, hook verification,
 * drafting.
 */
describe("a child that will not stop writing", () => {
  const FLOOD = "x".repeat(8 * 1024 * 1024);

  it("reports truncation when a later chunk arrives after an exactly full capture", async () => {
    const result = await runProcess({ command: process.execPath,
      args: ["-e", `process.stdout.write('x'.repeat(${MAX_CAPTURED_OUTPUT}), () => setTimeout(() => process.stdout.write('extra'), 10))`],
      timeoutMs: 5_000 });
    expect(result.stdout).toContain("stopped recording");
    expect(result.stdout).not.toContain("extra");
  });

  it("bounds UTF-8 bytes and does not split a multi-byte character", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: "\u20ac".repeat(MAX_CAPTURED_OUTPUT) });
    const result = await runProcess({ command: "noisy", args: [], timeoutMs: 1_000, spawnFn });
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(MAX_CAPTURED_OUTPUT + 200);
    expect(result.stdout).not.toContain("\ufffd");
    expect(result.stdout).toContain("stopped recording");
  });

  it("keeps a bounded amount of stdout and says it stopped recording", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: FLOOD, exitCode: 0 });

    const outcome = await runProcess({ command: "noisy", args: [], timeoutMs: 1_000, spawnFn });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.length).toBeLessThan(MAX_CAPTURED_OUTPUT + 200);
    expect(outcome.stdout).toContain("stopped recording");
  });

  it("bounds stderr the same way", async () => {
    const { spawnFn } = createFakeSpawn({ stderr: FLOOD, exitCode: 1 });

    const outcome = await runProcess({ command: "noisy", args: [], timeoutMs: 1_000, spawnFn });

    expect(outcome.stderr.length).toBeLessThan(MAX_CAPTURED_OUTPUT + 200);
  });

  /**
   * The cap is on what is *retained*. A caller streaming output has already
   * decided for itself what to keep, and cutting it off here would take that
   * decision away.
   */
  it("still streams every chunk to a caller that is reading them", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: FLOOD, exitCode: 0 });
    let streamed = 0;

    await runProcess({
      command: "noisy",
      args: [],
      timeoutMs: 1_000,
      spawnFn,
      onOutput: (_stream, chunk) => { streamed += chunk.length; },
    });

    expect(streamed).toBe(FLOOD.length);
  });

  it("keeps the beginning, which is where a version or an error is", async () => {
    const { spawnFn } = createFakeSpawn({ stdout: `anthill 1.2.3\n${FLOOD}`, exitCode: 0 });

    const outcome = await runProcess({ command: "noisy", args: [], timeoutMs: 1_000, spawnFn });

    expect(outcome.stdout.startsWith("anthill 1.2.3\n")).toBe(true);
  });
});
