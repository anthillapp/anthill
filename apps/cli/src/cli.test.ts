/**
 * The CLI's argument parsing: `--flag value` and `--flag=value`, the defaults,
 * and the errors (an unknown argument, a missing value, a bad port).
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { acquireInstanceLock, extractDataDir, parseArgs, recordListening, runReportCommand } from "./cli.js";
import type { HarnessReport } from "@anthill/live";

/**
 * Run a parser expecting it to fail, and return what it said on stderr.
 * `fail()` calls `process.exit(1)`, so the exit is turned into a sentinel
 * throw that this helper catches; the `console.error` output is what the
 * author actually reads, and what these tests assert on.
 */
function expectFailure(run: () => void): string {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let message = "";
  try {
    run();
  } catch (caught) {
    if (!(caught instanceof Error) || !caught.message.startsWith("exit:")) {
      throw caught;
    }
  } finally {
    // Capture before restoring: `mockRestore()` clears `mock.calls`.
    message = error.mock.calls.map((call) => call.join(" ")).join("\n");
    exit.mockRestore();
    error.mockRestore();
  }
  return message;
}

describe("parseArgs", () => {
  it("defaults to the loopback, port 4173, and a browser", () => {
    expect(parseArgs([])).toEqual({
      port: 4173,
      host: "127.0.0.1",
      openBrowser: true,
      workspace: undefined,
      dataDir: undefined,
    });
  });

  it("reads --port / --host / --workspace / --data-dir as `flag value`", () => {
    expect(
      parseArgs(["--port", "8080", "--host", "0.0.0.0", "--workspace", "/w", "--data-dir", "/d"]),
    ).toEqual({
      port: 8080,
      host: "0.0.0.0",
      openBrowser: true,
      workspace: "/w",
      dataDir: "/d",
    });
  });

  it("reads `flag=value`", () => {
    expect(parseArgs(["--port=9090", "--host=127.0.0.1"])).toMatchObject({
      port: 9090,
      host: "127.0.0.1",
    });
  });

  it("turns --no-browser off", () => {
    expect(parseArgs(["--no-browser"]).openBrowser).toBe(false);
  });

  it("fails, at the point of the mistake, when a value-required flag is followed by another option", () => {
    // The regression the review caught: `--host --no-browser` used to read
    // `--no-browser` as the host, and only failed at the end. Now it fails
    // here, naming the real problem.
    const message = expectFailure(() => parseArgs(["--host", "--no-browser"]));
    expect(message).toContain("--host needs a value");
    expect(message).toContain("--no-browser");
  });

  it("fails when a value-required flag is the last argument", () => {
    expect(expectFailure(() => parseArgs(["--port"]))).toContain("--port needs a value");
  });

  it("fails on a bad port", () => {
    const message = expectFailure(() => parseArgs(["--port", "not-a-number"]));
    expect(message).toContain("--port");
  });

  it("fails on an unknown argument", () => {
    expect(expectFailure(() => parseArgs(["--bogus"]))).toContain("unknown argument");
  });

  it("still accepts a value that starts with `-` via `flag=value`", () => {
    expect(parseArgs(["--host=-weird"]).host).toBe("-weird");
  });
});

describe("runReportCommand", () => {
  /** A write that records the reports instead of touching the file system. */
  function recorder(): { reports: HarnessReport[]; write: (report: HarnessReport) => Promise<void> } {
    const reports: HarnessReport[] = [];
    return { reports, write: async (report) => reports.push(report) };
  }

  it("records a run report and says so", async () => {
    const { reports, write } = recorder();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runReportCommand(["run", "ANT-1A2B3C4D", "9f8e7d"], write);
      expect(code).toBe(0);
      expect(reports).toEqual([
        expect.objectContaining({ kind: "run", runId: "ANT-1A2B3C4D", nonce: "9f8e7d" }),
      ]);
      expect(log.mock.calls.flat().join(" ")).toContain("Run reported.");
    } finally {
      log.mockRestore();
    }
  });

  it("records a step report and names the step", async () => {
    const { reports, write } = recorder();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runReportCommand(["step", "ANT-1A2B3C4D", "9f8e7d", "implement"], write);
      expect(code).toBe(0);
      expect(reports).toEqual([
        expect.objectContaining({ kind: "step", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", stepId: "implement" }),
      ]);
      expect(log.mock.calls.flat().join(" ")).toContain("Step implement reported.");
    } finally {
      log.mockRestore();
    }
  });

  it("records a done report and says so", async () => {
    const { reports, write } = recorder();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runReportCommand(["done", "ANT-1A2B3C4D", "9f8e7d"], write);
      expect(code).toBe(0);
      expect(reports).toEqual([
        expect.objectContaining({ kind: "done", runId: "ANT-1A2B3C4D", nonce: "9f8e7d" }),
      ]);
      expect(log.mock.calls.flat().join(" ")).toContain("Done reported.");
    } finally {
      log.mockRestore();
    }
  });

  it("fails when a value is missing", async () => {
    const { write } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReportCommand(["run", "ANT-1A2B3C4D"], write)).toBe(1);
      expect(await runReportCommand(["step", "ANT-1A2B3C4D", "9f8e7d"], write)).toBe(1);
      expect(await runReportCommand(["done", "ANT-1A2B3C4D"], write)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("fails when a value is extra", async () => {
    const { write } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReportCommand(["run", "a", "b", "c"], write)).toBe(1);
      expect(await runReportCommand(["step", "a", "b", "c", "d"], write)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("fails on an empty value", async () => {
    const { write } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReportCommand(["run", "", "9f8e7d"], write)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("fails on a value with whitespace", async () => {
    const { write } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReportCommand(["step", "ANT 1", "9f8e7d", "implement"], write)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("fails on an unknown command, with the usage", async () => {
    const { write } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReportCommand(["bogus"], write)).toBe(1);
      const message = error.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(message).toContain("unknown command");
      expect(message).toContain("anthill run <runId> <nonce>");
    } finally {
      error.mockRestore();
    }
  });

  it("fails, without reporting, when the write fails", async () => {
    const { reports } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = async () => {
      throw new Error("disk full");
    };
    try {
      expect(await runReportCommand(["run", "ANT-1A2B3C4D", "9f8e7d"], failing)).toBe(1);
      expect(reports).toEqual([]);
      expect(error.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("disk full");
    } finally {
      error.mockRestore();
    }
  });
});

describe("extractDataDir", () => {
  it("reads --data-dir after the command, leaving the rest of the argv", () => {
    expect(extractDataDir(["run", "ANT-1A2B3C4D", "9f8e7d", "--data-dir", "/d"])).toEqual({
      dataDir: "/d",
      argv: ["run", "ANT-1A2B3C4D", "9f8e7d"],
    });
  });

  it("reads `--data-dir=<value>`", () => {
    expect(extractDataDir(["step", "a", "b", "c", "--data-dir=/d"])).toEqual({
      dataDir: "/d",
      argv: ["step", "a", "b", "c"],
    });
  });

  it("leaves the argv untouched when the flag is absent", () => {
    expect(extractDataDir(["run", "a", "b"])).toEqual({ dataDir: undefined, argv: ["run", "a", "b"] });
  });

  it("fails, at the point of the mistake, when the value looks like an option", () => {
    // The same rule as the server's `parseArgs`: a flag that needs a value
    // never swallows the next option.
    const message = expectFailure(() => extractDataDir(["run", "a", "b", "--data-dir", "--port"]));
    expect(message).toContain("--data-dir needs a value");
    expect(message).toContain("--port");
  });

  it("fails when the flag is the last argument", () => {
    expect(expectFailure(() => extractDataDir(["run", "a", "b", "--data-dir"]))).toContain(
      "--data-dir needs a value",
    );
  });
});

describe("acquireInstanceLock", () => {
  /** A data directory, fresh and isolated per test. */
  async function tempDataDir(): Promise<string> {
    const dir = join(
      tmpdir(),
      `anthill-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** A pid that is, and stays, dead: a node process that exits immediately. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return child.pid;
  }

  async function readLockRecord(userData: string): Promise<{ pid: number }> {
    const raw: unknown = JSON.parse(
      await readFile(join(userData, "instance.lock"), "utf8"),
    );
    return raw as { pid: number };
  }

  it("creates the lock with its own pid when none exists", async () => {
    const userData = await tempDataDir();
    const release = await acquireInstanceLock({ userData, home: userData }, 4173, "127.0.0.1");
    expect((await readLockRecord(userData)).pid).toBe(process.pid);
    await release();
    await rm(userData, { recursive: true, force: true });
  });

  it("exits when a live instance holds the lock", async () => {
    const userData = await tempDataDir();
    await writeFile(
      join(userData, "instance.lock"),
      JSON.stringify({
        pid: process.pid,
        port: 4173,
        host: "127.0.0.1",
        startedAt: new Date().toISOString(),
      }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await acquireInstanceLock({ userData, home: userData }, 4173, "127.0.0.1");
      throw new Error("expected process.exit");
    } catch (error) {
      expect((error as Error).message).toBe("exit:1");
    } finally {
      exit.mockRestore();
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("takes over a stale lock (dead pid) and records its own pid", async () => {
    const userData = await tempDataDir();
    const dead = await deadPid();
    await writeFile(
      join(userData, "instance.lock"),
      JSON.stringify({
        pid: dead,
        port: 4173,
        host: "127.0.0.1",
        startedAt: new Date().toISOString(),
      }),
    );
    const release = await acquireInstanceLock({ userData, home: userData }, 4173, "127.0.0.1");
    expect((await readLockRecord(userData)).pid).toBe(process.pid);
    await release();
    await rm(userData, { recursive: true, force: true });
  });

  it("releases only a lock that still holds its own pid", async () => {
    const userData = await tempDataDir();
    const release = await acquireInstanceLock({ userData, home: userData }, 4173, "127.0.0.1");
    // Simulate losing the lock: another process now holds it.
    await writeFile(
      join(userData, "instance.lock"),
      JSON.stringify({
        pid: process.pid + 1,
        port: 4173,
        host: "127.0.0.1",
        startedAt: new Date().toISOString(),
      }),
    );
    await release();
    // The winner's lock must survive our shutdown.
    expect((await readLockRecord(userData)).pid).toBe(process.pid + 1);
    await rm(userData, { recursive: true, force: true });
  });
});

// ANT-231: the token a page needs to open /api, left where the MCP server can
// find it, for this user only.
describe("recordListening", () => {
  it("adds the token to this process's lock, keeping the rest, readable by the user alone", async () => {
    const dir = join(tmpdir(), `anthill-listen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    const paths = { userData: dir, home: dir };
    const release = await acquireInstanceLock(paths, 4180, "127.0.0.1");
    try {
      await recordListening(paths, "t0k");
      const lock = JSON.parse(await readFile(join(dir, "instance.lock"), "utf8")) as Record<string, unknown>;
      expect(lock).toMatchObject({ pid: process.pid, port: 4180, host: "127.0.0.1", token: "t0k" });
      if (process.platform !== "win32") {
        const { stat } = await import("node:fs/promises");
        expect((await stat(join(dir, "instance.lock"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await release();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing over a lock that is not this process's", async () => {
    const dir = join(tmpdir(), `anthill-listen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    const theirs = JSON.stringify({ pid: process.pid + 100000, port: 4180, host: "127.0.0.1", startedAt: "" });
    await writeFile(join(dir, "instance.lock"), theirs);
    await recordListening({ userData: dir, home: dir }, "t0k");
    expect(await readFile(join(dir, "instance.lock"), "utf8")).toBe(theirs);
    await rm(dir, { recursive: true, force: true });
  });
});

