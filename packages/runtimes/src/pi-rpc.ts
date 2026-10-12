import {
  MAX_CAPTURED_OUTPUT,
  defaultSpawn,
  type ChildProcessLike,
  type ProcessOutcome,
  type SpawnFn,
  type SpawnOptionsLike,
} from "./process-runner.js";

/**
 * Run one prompt through pi's **RPC mode** (`pi --mode rpc`) and collect the
 * reply from the event stream.
 *
 * The difference from `runProcess` is the ending: a `pi -p` child exits when
 * it is done, an RPC child is long-lived. So this runner settles on pi's own
 * `agent_settled` event — the run's authoritative "no remaining work" record —
 * and then terminates the child, which `runProcess` never has to do.
 *
 * What is read, and why only that:
 *
 * - `message_end` records for assistant messages — the authoritative final
 *   message per pi's JSON event stream; the last one's text blocks are the
 *   reply, and its `stopReason` says how the run ended (`stop` is natural,
 *   `error` carries an `errorMessage`, `aborted` means the user stopped it);
 * - `agent_settled` — the ending. `agent_end` is not used: retries and
 *   compaction recovery can continue after it;
 * - a `response` with `success: false` for the prompt command — the run was
 *   rejected before it started.
 *
 * Everything else on the stream is not read. The child's stdin is kept open
 * for the run's life: closing it would end the session, and the child is
 * killed — not left to exit on its own — when the run settles.
 *
 * Like `runProcess`, this never rejects: spawn failures, timeouts and
 * cancellation are reported through `ProcessOutcome`.
 */
export interface RunPiRpcOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Merged over `process.env`. */
  env?: Record<string, string>;
  /** The prompt, sent as the RPC `prompt` command. */
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
  /** Grace period between SIGTERM and SIGKILL when terminating. */
  killGraceMs?: number;
  /** How long to wait after SIGKILL before giving up on the `close` event. */
  forceResolveMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_FORCE_RESOLVE_MS = 500;

/** The assistant's last word, as the stream recorded it. */
interface FinalMessage {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The text of an assistant message: its `text` blocks, in order. */
function textOf(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function runPiRpc(options: RunPiRpcOptions): Promise<ProcessOutcome> {
  const {
    command,
    args,
    cwd,
    env,
    prompt,
    timeoutMs,
    signal,
    spawnFn = defaultSpawn,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    forceResolveMs = DEFAULT_FORCE_RESOLVE_MS,
  } = options;

  return new Promise<ProcessOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let finalMessage: FinalMessage | undefined;
    let buffer = "";

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
          timers.push(
            setTimeout(() => {
              finish(null);
            }, forceResolveMs),
          );
        }, killGraceMs),
      );
    }

    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs),
    );

    signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        handleRecord(record);
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      if (Buffer.byteLength(stderr) < MAX_CAPTURED_OUTPUT) stderr += text;
    });

    child.on("close", (code: number | null) => {
      // The child went away before the run settled: flush whatever the stream
      // was still holding (a final record without its trailing newline), then
      // this is the ending.
      if (buffer.trim()) {
        const rest = buffer;
        buffer = "";
        try {
          handleRecord(JSON.parse(rest) as Record<string, unknown>);
        } catch {
          /* a partial record is not a record */
        }
      }
      finish(code);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      stderr = errorMessage(error);
      finish(null);
    });

    // The prompt goes out as the RPC `prompt` command — one JSON record on
    // its own line. Stdin stays open: the session lives as long as it does.
    if (child.stdin) {
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    }

    function handleRecord(record: Record<string, unknown>): void {
      if (record.type === "message_end") {
        const message = isRecord(record.message) ? record.message : undefined;
        if (message?.role === "assistant") {
          finalMessage = {
            text: textOf(message),
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
            errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
          };
        }
        return;
      }

      if (record.type === "response" && record.command === "prompt" && record.success === false) {
        // The run was rejected before it started.
        stderr =
          typeof record.error === "string"
            ? record.error
            : "pi rejected the prompt before the run started.";
        finish(1);
        return;
      }

      if (record.type === "agent_settled") {
        // The run's own ending record. The reply is the assistant's last
        // word; the stop reason decides what "ended" means.
        stdout = finalMessage?.text ?? "";
        if (finalMessage?.stopReason === "error") {
          stderr = finalMessage.errorMessage ?? "pi recorded an error.";
          finish(1);
          return;
        }
        if (finalMessage?.stopReason === "aborted") {
          cancelled = true;
          finish(null);
          return;
        }
        // A settled run keeps a long-lived process alive on purpose. The run
        // is over — record it as such — and then end the child, the way a
        // `pi -p` child ended itself.
        finish(0);
        terminate();
      }
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
