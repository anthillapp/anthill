#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDataDir, resolvePaths } from "./paths.js";
import type { Paths } from "./paths.js";
import { startServer } from "./server.js";
import { createBridge } from "./bridge.js";
import { appendReport } from "./report.js";
import { observationCommand } from "./observation.js";
import type { HarnessReport } from "@anthill/live";

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
 *
 *   anthill run <runId> <nonce>        report that a run has started
 *   anthill step <runId> <nonce> <id>  report that a step has started
 *   anthill done <runId> <nonce>       report that the work is finished
 *
 * The report subcommands accept `--data-dir <p>` (after the command), so a
 * server started with `--data-dir X` reads reports from `X`, exactly where
 * `anthill run --data-dir X …` writes them.
 *
 * The file's leading hashbang (`#!/usr/bin/env node`) is load-bearing: the
 * package's `bin` entry points at the compiled file, and `npm` runs it as an
 * executable. Without it, a direct `anthill` falls through to the shell, which
 * cannot run a `.js` file. TypeScript preserves a leading hashbang in the
 * emitted JavaScript, so the compiled `cli.js` carries it too.
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
    "usage: anthill [options]            start the app on 127.0.0.1 and open it",
    "       anthill run <runId> <nonce>",
    "       anthill step <runId> <nonce> <stepId>",
    "       anthill done <runId> <nonce>",
    "       anthill observation status|enable|skip",
    "",
    "  --port <n>       listen on this port (default 4173)",
    "  --host <h>       bind to this interface (default 127.0.0.1)",
    "  --no-browser     do not try to open a browser; print the URL instead",
    "  --workspace <p>  start with this workspace already selected",
    "  --data-dir <p>   where to keep the CLI's own files (default ~/.anthill/cli)",
    "  -h, --help       show this help",
    "",
    "  The report subcommands (run, step, done) also accept --data-dir <p>",
    "  after the command, so a server started with --data-dir X reads the",
    "  reports from X, where `anthill run --data-dir X …` writes them.",
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
 * Both `--flag value` and `--flag=value` are accepted; an unknown argument,
 * a missing value, or a value that looks like another option is an error on
 * stderr. Failing at the point of the mistake (rather than only at the end,
 * when a swallowed flag has already been consumed as a value) is what makes
 * the error message point at the real problem.
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
    // A following token that looks like an option (`-…`) is not a value: it
    // is the next flag, and reading it as a value is how `--host --no-browser`
    // used to silently turn into `host = "--no-browser"`. Reject it here,
    // at the point of the mistake, with a message that names the real problem.
    // A legitimate value that merely starts with `-` (a negative port, a path
    // like `-weird`) is still available via `--flag=value`.
    const take = (): [string, number] => {
      if (inline !== undefined) return [inline, 1];
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} needs a value`);
      if (next.startsWith("-")) {
        fail(
          `${arg} needs a value, but the next argument (${next}) looks like an option. ` +
            `Pass the value with ${arg}=<value>, or move ${next} after the value.`,
        );
      }
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

/**
 * Pull `--data-dir` out of the report subcommands' argv.
 *
 * The subcommands resolve their own paths (no server), so `--data-dir` is
 * the one option they accept: a server started with `--data-dir X` reads
 * reports from `X`, and a harness that reports with `--data-dir X` writes
 * them there — the two agree on where the report file lives. A value that
 * looks like an option is rejected, the same rule as `parseArgs`: a
 * swallowed flag is how `--data-dir --port` would become a path.
 */
export function extractDataDir(
  argv: string[],
): { dataDir: string | undefined; argv: string[] } {
  let dataDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      const next = argv[i + 1];
      if (next === undefined) fail("--data-dir needs a value");
      if (next.startsWith("-")) {
        fail(
          `--data-dir needs a value, but the next argument (${next}) looks like an option. ` +
            `Pass the value with --data-dir=<value>, or move ${next} after the value.`,
        );
      }
      dataDir = next;
      i += 1;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else {
      rest.push(arg);
    }
  }
  return { dataDir, argv: rest };
}

/**
 * The report subcommands: `anthill run <runId> <nonce>`,
 * `anthill step <runId> <nonce> <stepId>`, and
 * `anthill done <runId> <nonce>`.
 *
 * These are what the prompt tells the harness to run. They append one line
 * to the report file and exit. They never start the server and never take
 * the instance lock, so a harness mid-step cannot be blocked by a running
 * Anthill, and a harness on a machine without one simply gets an error.
 *
 * `write` is injected so a test can record the report instead of touching
 * the file system.
 */
export async function runReportCommand(
  argv: string[],
  write: (report: HarnessReport) => Promise<void>,
): Promise<number> {
  const [command, ...values] = argv;
  if (command !== "run" && command !== "step" && command !== "done") {
    console.error(`anthill: unknown command: ${command ?? ""}\n\n${usage()}`);
    return 1;
  }
  const expected = command === "step" ? 3 : 2;
  if (values.length !== expected) {
    console.error(
      command === "run"
        ? "usage: anthill run <runId> <nonce>"
        : command === "step"
          ? "usage: anthill step <runId> <nonce> <stepId>"
          : "usage: anthill done <runId> <nonce>",
    );
    return 1;
  }
  const bad = values.find((value) => value.length === 0 || /\s/.test(value));
  if (bad !== undefined) {
    console.error("Report values must be non-empty and contain no whitespace.");
    return 1;
  }
  try {
    if (command === "run") {
      await write({ kind: "run", runId: values[0]!, nonce: values[1]!, at: new Date().toISOString() });
    } else if (command === "step") {
      await write({ kind: "step", runId: values[0]!, nonce: values[1]!, stepId: values[2]!, at: new Date().toISOString() });
    } else {
      await write({ kind: "done", runId: values[0]!, nonce: values[1]!, at: new Date().toISOString() });
    }
  } catch (problem) {
    console.error(problem instanceof Error ? problem.message : "The report could not be written.");
    return 1;
  }
  console.log(
    command === "run"
      ? "Run reported."
      : command === "step"
        ? `Step ${values[2]!} reported.`
        : "Done reported.",
  );
  return 0;
}

/** The single-instance lock, in the data directory. */
const LOCK_FILE = "instance.lock";
/** A lock older than this is stale even if its pid is still alive (pid reuse). */
const LOCK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How many times to retry the exclusive create before giving up. Two is enough
 * for the common case (one winner, the rest exit on the second pass); the
 * budget exists so a pathological thrash fails honestly instead of looping.
 */
const MAX_LOCK_ATTEMPTS = 5;

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
 * Whether the lock file still holds *our* record.
 *
 * A successful exclusive create is not, by itself, proof of ownership: a
 * concurrent process taking over the same stale lock can remove the file and
 * recreate it after our create lands. Re-reading and checking the pid is what
 * turns "I created the file" into "I own the lock".
 */
async function verifyOurs(lockPath: string, pid: number): Promise<boolean> {
  const record = await readLock(lockPath);
  return record !== undefined && record.pid === pid;
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
 * The takeover is atomic, in the sense that matters: the lock is claimed with
 * an exclusive create (`open(…, "wx")`, i.e. `O_CREAT | O_EXCL`), which can
 * only ever succeed for one process. Taking over a stale lock means removing
 * the file and exclusive-creating again; a plain `writeFile` over the stale
 * file is not enough, because two processes can both read "stale" and both
 * write, and the last write wins while both believe they hold the lock. After
 * a successful create we re-read the file and check that it still holds our
 * pid; if a concurrent taker removed and recreated it in the meantime, we see
 * their pid, know we lost, and retry — at which point the winner's lock is
 * fresh and alive, so we exit. Only one process ever ends up owning the lock.
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

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const record: LockRecord = {
      pid: process.pid,
      port,
      host,
      startedAt: new Date().toISOString(),
    };

    if (await tryCreateFresh(lockPath, record)) {
      // We created the file. Verify we still own it (a concurrent taker may
      // have removed and recreated it after our create landed).
      if (await verifyOurs(lockPath, process.pid)) {
        return releaseLock(lockPath);
      }
      // We lost the race; the file now belongs to someone. Loop: the next
      // create will hit EEXIST, and the winner's lock is fresh and alive.
      continue;
    }

    // EEXIST: someone else holds the file. A live holder means a real
    // instance is running; a stale (or unreadable) record is taken over by
    // removing the file and exclusive-creating again (the loop above).
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
    await rm(lockPath, { force: true });
  }

  // Exhausted the attempts: more processes are thrashing this lock than the
  // retry budget allows. Failing is the honest outcome; a forced write would
  // reintroduce the race this whole protocol exists to avoid.
  fail(
    `Could not claim the single-instance lock at ${lockPath} after ` +
      `${MAX_LOCK_ATTEMPTS} attempts; another instance is likely starting. Try again.`,
  );
}

function releaseLock(lockPath: string): () => Promise<void> {
  return async () => {
    try {
      // Only remove a lock that still holds our pid: if we ever lost it, we
      // must not delete the winner's lock on the way out.
      const record = await readLock(lockPath);
      if (record !== undefined && record.pid === process.pid) {
        await rm(lockPath, { force: true });
      }
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
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const rendererDir = join(moduleDir, "../../renderer");

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
  if (process.argv[2] === "observation") {
    const reply = await observationCommand(process.argv.length === 4 ? process.argv[3] : undefined);
    console.log(JSON.stringify(reply.result));
    process.exitCode = reply.exitCode;
    return;
  }
  const argv = process.argv.slice(2);
  // The report subcommands are what the prompt tells the harness to run.
  // They append one line to the report file and exit: no server, no lock,
  // so a harness mid-step cannot be blocked by a running Anthill. They take
  // `--data-dir` (after the command), so a server started with
  // `--data-dir X` reads reports from `X`, exactly where the harness wrote
  // them.
  if (argv[0] === "run" || argv[0] === "step" || argv[0] === "done") {
    const { dataDir, argv: command } = extractDataDir(argv);
    const paths = await resolvePaths({ dataDir });
    const code = await runReportCommand(command, (report) => appendReport(paths, report));
    process.exit(code);
  }
  const options = parseArgs(argv);
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

  const url = `http://${options.host}:${server.port}/?token=${server.token}`;
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

// npm exposes this file through a symlink. Compare real paths so direct
// `anthill` execution runs main while Vitest imports remain side-effect free.
const invokedDirectly = process.argv[1] !== undefined && existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
