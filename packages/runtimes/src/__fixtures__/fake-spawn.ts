import type { ChildProcessLike, SpawnFn, SpawnOptionsLike } from "../process-runner.js";

/** Scripted behaviour for one fake child process. */
export interface FakeProcessScript {
  stdout?: string;
  stderr?: string;
  /** Exit code reported on `close`. Defaults to 0. */
  exitCode?: number | null;
  /** Delay before `close` fires. Defaults to 0 (next macrotask). */
  delayMs?: number;
  /** Never emit `close` on its own — used to exercise timeout / cancellation. */
  neverExits?: boolean;
  /** Ignore `kill()` entirely — used to exercise the SIGKILL escalation path. */
  ignoreKill?: boolean;
  /** Emit an `error` event (e.g. an ENOENT for a missing binary). */
  spawnError?: NodeJS.ErrnoException;
}

export interface FakeSpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptionsLike;
  stdin: string;
  killSignals: string[];
}

export interface FakeSpawn {
  spawnFn: SpawnFn;
  calls: FakeSpawnCall[];
}

type Listener = (...args: any[]) => void;

class FakeStream {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeStdin extends FakeStream {
  written = "";
  ended = false;

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

/**
 * Builds an injectable `spawnFn` that plays back scripted process behaviour.
 * Pass a single script (reused for every call) or one script per call.
 */
export function createFakeSpawn(scripts: FakeProcessScript | FakeProcessScript[]): FakeSpawn {
  const list = Array.isArray(scripts) ? scripts : [scripts];
  const calls: FakeSpawnCall[] = [];
  let index = 0;

  const spawnFn: SpawnFn = (command, args, options) => {
    const script = (Array.isArray(scripts) ? list[index] : list[0]) ?? list[list.length - 1] ?? {};
    index += 1;

    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const stdin = new FakeStdin();
    const proc = new FakeStream();
    const call: FakeSpawnCall = {
      command,
      args,
      options,
      get stdin() {
        return stdin.written;
      },
      killSignals: [],
    } as FakeSpawnCall;
    calls.push(call);

    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      proc.emit("close", code, null);
    };

    const child: ChildProcessLike = {
      stdout,
      stderr,
      stdin,
      on: (event: string, listener: Listener) => proc.on(event, listener),
      kill: (signal?: string) => {
        call.killSignals.push(signal ?? "SIGTERM");
        if (!script.ignoreKill) setTimeout(() => close(null), 0);
        return true;
      },
    };

    setTimeout(() => {
      if (script.spawnError) {
        proc.emit("error", script.spawnError);
        return;
      }
      if (script.stdout) stdout.emit("data", script.stdout);
      if (script.stderr) stderr.emit("data", script.stderr);
      if (!script.neverExits) {
        const exitCode = script.exitCode === undefined ? 0 : script.exitCode;
        if (script.delayMs) setTimeout(() => close(exitCode), script.delayMs);
        else close(exitCode);
      }
    }, 0);

    return child;
  };

  return { spawnFn, calls };
}

/** Convenience: the error Node raises when a binary is not on PATH. */
export function enoent(command: string): NodeJS.ErrnoException {
  const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.syscall = `spawn ${command}`;
  return error;
}
