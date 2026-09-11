import { spawn } from "node:child_process";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDataDir, resolvePaths } from "./paths.js";
import type { Paths } from "./paths.js";
import { startServer } from "./server.js";
import { createBridge } from "./bridge.js";

/**
 * `anthill` — run Anthill on Linux as a CLI that opens a web interface.
 *
 * One process, one loopback server, one browser tab. Argument parsing is
 * hand-rolled (no dependencies):
 *
 *   --port <n>       listen on this port (default 4173)
 *   --host <h>       bind to this interface (default 127.0.0.1)
 *   --no-browser     do not try to open a browser; print the URL instead
 *   --workspace <p>  start with this workspace already selected
 *   --data-dir <p>   where to keep the CLI's own files (default ~/.anthill/cli)
 */
export type CliOptions = {
  port: number;
  host: string;
  openBrowser: boolean;
  workspace?: string;
  dataDir?: string;
};

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";

function usage(): string {
  return [
    "usage: anthill [options]",
    "",
    "  --port <n>       listen on this port (default 4173)",
    "  --host <h>       bind to this interface (default 127.0.0.1)",
    "  --no-browser     do not try to open a browser; print the URL instead",
    "  --workspace <p>  start with this workspace already selected",
    "  --data-dir <p>   where to keep the CLI's own files (default ~/.anthill/cli)",
    "  -h, --help       show this help",
  ].join("\n");
}

function fail(message: string): never {
  console.error(`anthill: ${message}`);
  console.error(usage());
  process.exit(1);
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`--port must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

/**
 * Parse `process.argv.slice(2)` into `CliOptions`.
 *
 * Both `--flag value` and `--flag=value` are accepted; an unknown argument or
 * a missing value is an error on stderr.
 */
export function parseArgs(argv: string[]): CliOptions {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let openBrowser = true;
  let workspace: string | undefined;
  let dataDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i]!;
    // `--flag=value` is the same as `--flag value`: split it up front so the
    // checks below only ever see the bare flag name.
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        inline = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    // The value of `--flag value` (the next arg) or `--flag=value` (inline).
    const take = (): [string, number] => {
      if (inline !== undefined) return [inline, 1];
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} needs a value`);
      return [next, 2];
    };

    if (arg === "--port") {
      const [value, consumed] = take();
      port = parsePort(value);
      i += consumed - 1;
    } else if (arg === "--host") {
      const [value, consumed] = take();
      host = value;
      i += consumed - 1;
    } else if (arg === "--no-browser") {
      openBrowser = false;
    } else if (arg === "--workspace") {
      const [value, consumed] = take();
      workspace = value;
      i += consumed - 1;
    } else if (arg === "--data-dir") {
      const [value, consumed] = take();
      dataDir = value;
      i += consumed - 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return { port, host, openBrowser, workspace, dataDir };
}

/** The single-instance lock, in the data directory. */
const LOCK_FILE = "instance.lock";
/** A lock older than this is stale even if its pid is still alive (pid reuse). */
const LOCK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type LockRecord = {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
};

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFresh(record: LockRecord): boolean {
  if (record.startedAt !== "") {
    const started = Date.parse(record.startedAt);
    if (Number.isFinite(started) && Date.now() - started > LOCK_MAX_AGE_MS) {
      return false;
    }
  }
  return isProcessAlive(record.pid);
}

async function readLock(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      typeof record.port !== "number" ||
      typeof record.host !== "string"
    ) {
      return undefined;
    }
    return {
      pid: record.pid,
      port: record.port,
      host: record.host,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    };
  } catch {
    // Unreadable: treat as stale and take the lock over.
    return undefined;
  }
}

async function tryCreateFresh(
  lockPath: string,
  record: LockRecord,
): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Claim this machine's single CLI instance.
 *
 * A lock file in the data directory holds the pid (and port) of the running
 * instance. A second `anthill` on the same data directory finds a fresh lock
 * — the recorded pid is still alive — reports the first one's URL and exits
 * instead of starting a second server. A stale lock (the pid is gone, or the
 * lock is older than `LOCK_MAX_AGE_MS`) is taken over.
 *
 * Returns a function that releases the lock on the way out.
 */
export async function acquireInstanceLock(
  paths: Paths,
  port: number,
  host: string,
): Promise<() => Promise<void>> {
  await ensureDataDir(paths);
  const lockPath = join(paths.userData, LOCK_FILE);
  const record: LockRecord = {
    pid: process.pid,
    port,
    host,
    startedAt: new Date().toISOString(),
  };

  if (!(await tryCreateFresh(lockPath, record))) {
    const existing = await readLock(lockPath);
    if (existing !== undefined && isFresh(existing)) {
      const url = `http://${existing.host}:${existing.port}/`;
      console.error(
        `An Anthill instance is already running (pid ${existing.pid}) at ${url}.`,
      );
      console.error(
        "This one is exiting; stop that instance, or start with a different --data-dir.",
      );
      process.exit(1);
    }
    // Stale (or unreadable): take the lock over.
    await writeFile(lockPath, JSON.stringify(record, null, 2), "utf8");
  }

  return async () => {
    try {
      await rm(lockPath, { force: true });
    } catch {
      // A lock that outlives the process is harmless: once this pid is gone
      // the next start reads it as stale. Not worth failing a shutdown over.
    }
  };
}

/** The "open a URL" programs, in the order to try them on Linux. */
const BROWSER_OPENERS = ["xdg-open", "wslview", "sensible-browser"] as const;
/** How long to give each opener before trying the next. */
const OPENER_TIMEOUT_MS = 3000;

/**
 * Best-effort open of the author's default browser.
 *
 * Linux has no single "open a URL" API, so this tries `xdg-open` (and the
 * usual fallbacks) without ever blocking the server: if nothing can be
 * opened, the URL is printed and the run continues.
 */
export function openBrowser(url: string): void {
  void (async () => {
    for (const opener of BROWSER_OPENERS) {
      if (await tryOpen(opener, url)) return;
    }
    console.log(`Open this in a browser: ${url}`);
  })();
}

function tryOpen(opener: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => finish(false), OPENER_TIMEOUT_MS);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // ENOENT (not there) or EACCES (not executable): try the next opener.
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/**
 * Where the built renderer lives. `cli.js` compiles to `out/cli/src/`, the
 * renderer to `out/renderer/`, so two levels up from here.
 */
const rendererDir = join(__dirname, "../../renderer");

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.removeListener("SIGINT", done);
      process.removeListener("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

/**
 * The CLI entry point.
 */
export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const paths = await resolvePaths({ dataDir: options.dataDir });
  await ensureDataDir(paths);
  const releaseLock = await acquireInstanceLock(paths, options.port, options.host);

  // The web server: serves the renderer from `rendererDir` and answers
  // /health and the /api WebSocket on the loopback interface.
  const server = await startServer({
    host: options.host,
    port: options.port,
    paths,
    rendererDir,
  });

  // The bridge: maps every `IpcChannel` onto the reused service modules and
  // broadcasts the push channels over the WebSocket. It installs its request
  // dispatcher on the server's `onMessage` and pushes through `broadcast`.
  const bridge = await createBridge({
    paths,
    workspace: options.workspace,
    broadcast: server.broadcast,
    onMessage: server.onMessage,
  });

  const url = `http://${options.host}:${server.port}/`;
  if (options.openBrowser) {
    openBrowser(url);
  } else {
    console.log(`Open this in a browser: ${url}`);
  }

  await waitForSignal();
  await bridge.close();
  await server.close();
  await releaseLock();
}

// The entry point: run `main` only when this file is executed directly (the
// CJS `require.main === module` idiom), not when it is imported. A failure is
// reported and exits non-zero.
declare const module: { id: string };
if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
