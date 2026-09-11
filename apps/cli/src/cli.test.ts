/**
 * The CLI's argument parsing: `--flag value` and `--flag=value`, the defaults,
 * and the errors (an unknown argument, a missing value, a bad port).
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { acquireInstanceLock, parseArgs } from "./cli.js";

/**
 * Run `parseArgs` expecting it to fail, and return what it said on stderr.
 * `fail()` calls `process.exit(1)`, so the exit is turned into a sentinel
 * throw that this helper catches; the `console.error` output is what the
 * author actually reads, and what these tests assert on.
 */
function expectFailure(argv: string[]): string {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let message = "";
  try {
    parseArgs(argv);
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
    const message = expectFailure(["--host", "--no-browser"]);
    expect(message).toContain("--host needs a value");
    expect(message).toContain("--no-browser");
  });

  it("fails when a value-required flag is the last argument", () => {
    expect(expectFailure(["--port"])).toContain("--port needs a value");
  });

  it("fails on a bad port", () => {
    expect(expectFailure(["--port", "not-a-number"])).toContain("--port");
  });

  it("fails on an unknown argument", () => {
    expect(expectFailure(["--bogus"])).toContain("unknown argument");
  });

  it("still accepts a value that starts with `-` via `flag=value`", () => {
    expect(parseArgs(["--host=-weird"]).host).toBe("-weird");
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
