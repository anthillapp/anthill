import { spawn } from "node:child_process";

/**
 * Minimal structural shapes for a spawned process. Deliberately narrower than
 * Node's `ChildProcess` so unit tests can substitute a fake without pulling in
 * streams — Node's real `spawn` result satisfies these interfaces.
 */
export interface ReadableLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setEncoding?(encoding: string): unknown;
}

export interface WritableLike {
  write(chunk: string): unknown;
  end(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ChildProcessLike {
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  stdin: WritableLike | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface SpawnOptionsLike {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** The injectable spawn seam used by every process-backed runtime. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildProcessLike;

/** Wraps `child_process.spawn` so it conforms to `SpawnFn`. */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Merged over `process.env`. */
  env?: Record<string, string>;
  /** Written to stdin then closed. Omit to close stdin immediately. */
  stdinPayload?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
  /** Grace period between SIGTERM and SIGKILL when terminating. */
  killGraceMs?: number;
  /** How long to wait after SIGKILL before giving up on the `close` event. */
  forceResolveMs?: number;
  /**
   * Called as output arrives, stream by stream, before the run finishes.
   *
   * For callers who need to know *that* the process is speaking — a liveness
   * or progress signal — without waiting for the collected outcome. The chunk
   * is passed so a caller can measure it; treating its content as status is
   * the caller's own responsibility to resist.
   */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  spawnError?: NodeJS.ErrnoException;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_FORCE_RESOLVE_MS = 500;

/**
 * Spawns a process and collects its output. Never rejects: spawn failures,
 * timeouts and cancellation are all reported through `ProcessOutcome` so that
 * callers can hand the outcome straight to `normalizeProcessOutput`.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessOutcome> {
  const {
    command,
    args,
    cwd,
    env,
    stdinPayload,
    timeoutMs,
    signal,
    spawnFn = defaultSpawn,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    forceResolveMs = DEFAULT_FORCE_RESOLVE_MS,
    onOutput,
  } = options;

  return new Promise<ProcessOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnError: NodeJS.ErrnoException | undefined;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };

    if (signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }

    const onAbort = () => {
      cancelled = true;
      terminate();
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, spawnError });
    };

    let child: ChildProcessLike;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (error) {
      spawnError = error as NodeJS.ErrnoException;
      stderr = errorMessage(error);
      finish(null);
      return;
    }

    function terminate(): void {
      try {
        child.kill("SIGTERM");
      } catch {
        /* process may already be gone */
      }
      timers.push(
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* process may already be gone */
          }
          timers.push(setTimeout(() => finish(null), forceResolveMs));
        }, killGraceMs),
      );
    }

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: unknown) => {
      const text = toText(chunk);
      stdout += text;
      onOutput?.("stdout", text);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      const text = toText(chunk);
      stderr += text;
      onOutput?.("stderr", text);
    });

    child.on("error", (error: unknown) => {
      spawnError = error as NodeJS.ErrnoException;
      if (stderr.length === 0) stderr = errorMessage(error);
      finish(null);
    });

    child.on("close", (code: number | null) => {
      finish(typeof code === "number" ? code : null);
    });

    if (child.stdin) {
      // Swallow EPIPE: a CLI is free to exit before reading the whole prompt.
      child.stdin.on("error", () => undefined);
      try {
        if (stdinPayload !== undefined) child.stdin.write(stdinPayload);
        child.stdin.end();
      } catch {
        /* stdin already closed */
      }
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs),
      );
    }
  });
}

function toText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk === null || chunk === undefined) return "";
  return String(chunk);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
