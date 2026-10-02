/**
 * Recognising, and then following, a VS Code agent chat.
 *
 * VS Code saves each chat to
 * `<user data>/User/workspaceStorage/<hash>/chatSessions/<session id>.jsonl`
 * (chats in a window with no folder go to `globalStorage/emptyWindowChatSessions`).
 * The file is an operation log of VS Code's own, which it calls unstable:
 *
 * - `{kind: 0, v}` is the whole chat, and replaces whatever came before;
 * - `{kind: 1, k, v}` sets the value at path `k` (a missing `v` is undefined);
 * - `{kind: 2, k, v?, i?}` cuts the array at `k` to length `i`, when given,
 *   then appends `v`;
 * - `{kind: 3, k}` deletes the value at `k`.
 *
 * VS Code rewrites the file as a single `kind: 0` line now and then, so it is
 * replayed whole whenever it changes rather than tailed. And it saves on its
 * own schedule — about once a minute, when the window loses focus, and on
 * exit — so what this reads can trail the chat by that much. Nothing here
 * pretends otherwise: a step reported through `anthill step` arrives on its
 * own channel and does not wait for VS Code.
 *
 * What is read is deliberately narrow:
 *
 * - each request's user text: only whether it carries the run marker;
 * - each request's state: pending, complete, cancelled, failed, or waiting
 *   for the person, and when it completed;
 * - markdown parts of a response: any Anthill step marker, and one cut-down
 *   line of what the agent said. `thinking` parts are skipped by name before
 *   anything is read out of them;
 * - tool parts: the tool's id, the call's id, and whether it came back and
 *   how. Never its input, its output, or a terminal command's text — except
 *   that the whole record is searched for a bound run's nonce, which is the
 *   one way a plugin handover's chat can be told apart.
 *
 * A part has no time of its own in the file. The request's own time, its
 * completion and a terminal command's are real; a part between them is given
 * the next millisecond after the last real time, so parts keep their order and
 * a re-read gives every event the same time it had before.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TIMING,
  boundSessionId,
  isAnthillTool,
  messageExcerpt,
  parseStepMarkers,
  textCarriesMarker,
  type Evidence,
  type PendingRun,
} from "@anthill/live";

import {
  isThisRun,
  type LiveSessionObserver,
  type ObservationEventDraft,
  type ObserverCapabilities,
  type PollResult,
} from "./types.js";

const CHANNEL = "vscode:chat";

/**
 * How quiet a chat must be before its last finished request counts as the
 * work being over. The same silence the other observers wait out.
 */
const SETTLE_MS = 5 * 60_000;

/** Larger than any chat VS Code would keep; a file past it is not read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** `modelState.value`, as VS Code numbers it. */
const MODEL_STATE = { pending: 0, complete: 1, cancelled: 2, failed: 3, needsInput: 4 } as const;

/** `isConfirmed.type` values that mean the tool never ran. */
const NOT_RUN = new Set([0 /* denied */, 5 /* skipped */]);

/** Where VS Code keeps its user data on this platform. */
export function vscodeUserDir(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Code", "User")
    : platform === "win32"
      ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User")
      : join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User");
}

/* ------------------------------------------------------------------ */
/* The operation log                                                   */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The chat a session file describes, replayed from its operation log.
 *
 * A flat `.json` file — VS Code's older format, still written when the log is
 * switched off — is the chat itself. A line that does not parse is skipped:
 * the last one may be half written, and nothing else in the file depends on it
 * having been there.
 */
export function replayChatLog(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("\n")) {
    try {
      const whole: unknown = JSON.parse(trimmed);
      if (isRecord(whole) && !("kind" in whole && "v" in whole)) return whole;
    } catch {
      return undefined;
    }
  }

  let state: unknown;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const kind = entry.kind;
    if (kind === 0) {
      state = entry.v;
      continue;
    }
    const path = Array.isArray(entry.k) ? (entry.k as (string | number)[]) : undefined;
    if (!path || path.length === 0 || !isRecord(state)) continue;
    const parent = walk(state, path.slice(0, -1));
    if (parent === undefined) continue;
    const last = path[path.length - 1] as string | number;
    const target = parent as Record<string | number, unknown>;
    if (kind === 1) target[last] = entry.v;
    else if (kind === 3) target[last] = undefined;
    else if (kind === 2) {
      const array = Array.isArray(target[last]) ? (target[last] as unknown[]) : [];
      if (typeof entry.i === "number") array.length = entry.i;
      if (Array.isArray(entry.v)) array.push(...entry.v);
      target[last] = array;
    }
  }
  return isRecord(state) ? state : undefined;
}

function walk(root: unknown, path: (string | number)[]): object | undefined {
  let at: unknown = root;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return typeof at === "object" && at !== null ? at : undefined;
}

/* ------------------------------------------------------------------ */
/* What a chat says                                                    */
/* ------------------------------------------------------------------ */

type Part =
  | { kind: "markdown"; text: string }
  | { kind: "tool"; toolId: string; callId?: string; at?: number; ended: boolean; ok: boolean; waiting: boolean }
  | { kind: "other" };

type Request = {
  id: string;
  index: number;
  /** When the person sent it. */
  at: number;
  text: string;
  /** When the response began, when VS Code recorded it. */
  respondedAt?: number;
  parts: Part[];
  state?: number;
  completedAt?: number;
  error?: string;
  /** The request as VS Code wrote it, for the one search that needs it. */
  raw: string;
};

type Chat = { sessionId?: string; createdAt?: number; requests: Request[] };

export function readChat(chat: Json): Chat {
  const requests = Array.isArray(chat.requests) ? chat.requests : [];
  return {
    ...(str(chat.sessionId) ? { sessionId: str(chat.sessionId) } : {}),
    ...(num(chat.creationDate) !== undefined ? { createdAt: num(chat.creationDate) } : {}),
    requests: requests.filter(isRecord).map((request, index): Request => {
      const message = isRecord(request.message) ? request.message : {};
      const modelState = isRecord(request.modelState) ? request.modelState : {};
      const result = isRecord(request.result) ? request.result : {};
      const errorDetails = isRecord(result.errorDetails) ? result.errorDetails : undefined;
      return {
        id: str(request.requestId) ?? `request-${index}`,
        index,
        at: num(request.timestamp) ?? 0,
        text: str(message.text) ?? "",
        ...(num(request.responseTimestamp) !== undefined ? { respondedAt: num(request.responseTimestamp) } : {}),
        parts: (Array.isArray(request.response) ? request.response : []).map(readPart),
        ...(num(modelState.value) !== undefined ? { state: num(modelState.value) } : {}),
        ...(num(modelState.completedAt) !== undefined ? { completedAt: num(modelState.completedAt) } : {}),
        ...(errorDetails && str(errorDetails.message) ? { error: str(errorDetails.message) } : {}),
        raw: JSON.stringify(request),
      };
    }),
  };
}

function readPart(value: unknown): Part {
  if (!isRecord(value)) return { kind: "other" };
  // Markdown is the one part with no `kind`. The model's own working is
  // `thinking`, and is left where it is without being read.
  if (value.kind === undefined && typeof value.value === "string") return { kind: "markdown", text: value.value };
  if (value.kind !== "toolInvocationSerialized") return { kind: "other" };

  const data = isRecord(value.toolSpecificData) ? value.toolSpecificData : {};
  const terminal = data.kind === "terminal" && isRecord(data.terminalCommandState) ? data.terminalCommandState : undefined;
  const result = isRecord(value.resultDetails) ? value.resultDetails : undefined;
  const confirmed = isRecord(value.isConfirmed) ? num(value.isConfirmed.type) : undefined;
  const exitCode = terminal ? num(terminal.exitCode) : undefined;
  const notRun = confirmed !== undefined && NOT_RUN.has(confirmed);
  // `isComplete` is written as true while the tool is still running, so it
  // says nothing. A result, an exit code, or a refusal says it is over.
  const ended = result !== undefined || exitCode !== undefined || notRun;
  return {
    kind: "tool",
    toolId: str(value.toolId) ?? "a tool",
    ...(str(value.toolCallId) ? { callId: str(value.toolCallId) } : {}),
    ...(terminal && num(terminal.timestamp) !== undefined ? { at: num(terminal.timestamp) } : {}),
    ended,
    ok: !notRun && result?.isError !== true && (exitCode === undefined || exitCode === 0),
    // Asked and not yet answered: the person has a confirmation in front of them.
    waiting: value.isConfirmed === undefined && !ended,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function terminal(request: Request): boolean {
  return request.state === MODEL_STATE.complete || request.state === MODEL_STATE.cancelled || request.state === MODEL_STATE.failed;
}

/* ------------------------------------------------------------------ */
/* The observer                                                        */
/* ------------------------------------------------------------------ */

type FileState = {
  /** What the file was when last replayed: a change in either means read it again. */
  mtimeMs: number;
  size: number;
  chat?: Chat;
  cwd?: string;
  /** Where in the chat this run begins: the request, and the part within it. */
  from?: { request: number; part: number };
  /** Events already reported, by their place in the chat. */
  emitted: Set<string>;
  reportedActivityAt?: string;
};

type Marker = { runId: string; nonce: string };

export class VSCodeObserver implements LiveSessionObserver {
  readonly cli = "vscode" as const;

  private readonly seen = new Map<string, Map<string, FileState>>();

  /** The user data folder is injectable so the reader can be tested against fixtures. */
  constructor(private readonly userDir: string = vscodeUserDir()) {}

  private get workspaceStorage(): string {
    return join(this.userDir, "workspaceStorage");
  }

  async detectCapabilities(): Promise<ObserverCapabilities> {
    const available = await stat(this.workspaceStorage).then(
      (info) => info.isDirectory(),
      () => false,
    );
    return {
      cli: this.cli,
      available,
      root: this.workspaceStorage,
      note: available
        ? "Anthill reads the chat sessions VS Code saves for itself. VS Code saves them about once a minute, so what Anthill shows can trail the chat by that much."
        : "VS Code has saved no chat sessions on this machine, so there is nothing to read.",
      reportsCompletion: true,
      reportsFailure: true,
    };
  }

  forget(runId: string): void {
    this.seen.delete(runId);
  }

  async poll(run: PendingRun, now: string): Promise<PollResult> {
    const files = await this.candidates(run);
    // No chat saved yet is a VS Code that has not been asked anything, not one
    // Anthill cannot read: the ordinary wait applies (ANT-212).
    if (files === undefined) return { events: [], evidence: [] };

    const states = this.statesFor(run.anthillRunId);
    const marker: Marker = { runId: run.anthillRunId, nonce: run.correlationNonce };
    // A plugin handover names its chat; the service resolves the name the
    // plugin made up to VS Code's own id with `locate`, and until it has, no
    // chat here is that one.
    const bound = boundSessionId(run);
    await this.refresh(files, states, marker, bound !== undefined);

    // One chat can be saved under more than one workspace folder; the newest
    // copy speaks for it.
    const newest = new Map<string, [string, FileState]>();
    for (const [path, state] of states) {
      const id = state.chat?.sessionId;
      if (!id || !state.from || (bound !== undefined && id !== bound)) continue;
      const held = newest.get(id);
      if (!held || held[1].mtimeMs < state.mtimeMs) newest.set(id, [path, state]);
    }
    const matched = [...newest.values()];

    if (matched.length > 1) {
      const speaking = matched.filter(([, state]) => contends(state, now));
      if (speaking.length > 1) {
        return {
          events: [],
          evidence: [{ kind: "ambiguous", sessionIds: speaking.map(([, state]) => state.chat!.sessionId!), channel: CHANNEL, at: now }],
        };
      }
      if (speaking.length === 0) return { events: [], evidence: [] };
      matched.splice(0, matched.length, ...speaking);
    }

    const [entry] = matched;
    if (!entry) return { events: [], evidence: [] };
    const [, state] = entry;
    const chat = state.chat!;
    const sessionId = chat.sessionId!;

    const all = eventsOf(chat, state.from!, marker, sessionId);
    const fresh = all.filter((event) => !state.emitted.has(event.key));
    for (const event of fresh) state.emitted.add(event.key);
    const events = fresh.map(({ key: _key, ...event }) => event).filter((event) => isThisRun(event, run));

    const evidence: Evidence[] = [];
    const lastAt = all.length > 0 ? all[all.length - 1]!.at : undefined;
    if (run.detectedSessionId !== sessionId) {
      evidence.push({
        kind: "match",
        sessionId,
        // The marker is in a record VS Code wrote itself, or the run's own
        // nonce is: as good as it gets short of an id Anthill assigned.
        confidence: "strong",
        channel: CHANNEL,
        at: lastAt ?? now,
        ...(state.cwd ? { cwd: state.cwd } : {}),
      });
    } else if (fresh.length > 0 && lastAt && lastAt !== state.reportedActivityAt) {
      evidence.push({
        kind: "activity",
        sessionId,
        at: lastAt,
        channel: CHANNEL,
        // Only a new request or a tool of the work's own resumes a finished
        // run; Anthill's own tools and the closing words do not (ANT-188, ANT-215).
        resumes: fresh.some(
          (event) => event.kind === "prompt.submit" || (event.kind === "tool.start" && !isAnthillTool(event.toolName)),
        ),
      });
    }
    state.reportedActivityAt = lastAt;
    evidence.push(...standing(chat, state.from!, sessionId, run, now, lastAt));
    return { evidence, events };
  }

  /**
   * VS Code's own id for the chat a plugin handover is working in.
   *
   * The plugin hands over under an id it made, because VS Code gives a chat
   * none it can read. The chat is the one whose agent ran or was answered
   * with this run's nonce after binding — one chat, or no answer.
   */
  async locate(run: PendingRun): Promise<string | undefined> {
    const files = await this.candidates(run);
    if (!files) return undefined;
    const states = this.statesFor(run.anthillRunId);
    await this.refresh(files, states, { runId: run.anthillRunId, nonce: run.correlationNonce }, true);
    const found = new Set([...states.values()].filter((state) => state.from && state.chat?.sessionId).map((state) => state.chat!.sessionId!));
    return found.size === 1 ? [...found][0] : undefined;
  }

  /** Replay every candidate that changed since it was last read. */
  private async refresh(
    files: { path: string; mtimeMs: number; size: number; cwd?: string }[],
    states: Map<string, FileState>,
    marker: Marker,
    bound: boolean,
  ): Promise<void> {
    for (const file of files) {
      const state = states.get(file.path) ?? { mtimeMs: -1, size: -1, emitted: new Set<string>() };
      states.set(file.path, state);
      if (state.mtimeMs === file.mtimeMs && state.size === file.size) continue;
      state.mtimeMs = file.mtimeMs;
      state.size = file.size;
      const text = await readFile(file.path, "utf8").catch(() => undefined);
      const replayed = text === undefined ? undefined : replayChatLog(text);
      if (!replayed) continue;
      state.chat = readChat(replayed);
      state.cwd ??= file.cwd;
      state.from ??= startOf(state.chat, marker, bound);
    }
  }

  /** Chat files written since this run was created, with the folder each belongs to. */
  private async candidates(run: PendingRun): Promise<{ path: string; mtimeMs: number; size: number; cwd?: string }[] | undefined> {
    const workspaces = await readdir(this.workspaceStorage).catch(() => undefined);
    const empty = join(this.userDir, "globalStorage", "emptyWindowChatSessions");
    const emptyNames = await readdir(empty).catch(() => undefined);
    if (workspaces === undefined && emptyNames === undefined) return undefined;

    // A minute of slack for clocks, and another for VS Code's own saving: a
    // chat started just before the copy may not have been written until after.
    const floor = Date.parse(run.createdAt) - 2 * 60_000;
    const found: { path: string; mtimeMs: number; size: number; cwd?: string }[] = [];
    const take = async (dir: string, names: string[], cwd?: () => Promise<string | undefined>) => {
      for (const name of names) {
        if (!name.endsWith(".jsonl") && !name.endsWith(".json")) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile() || info.mtimeMs < floor || info.size > MAX_FILE_BYTES) continue;
        const folder = cwd ? await cwd() : undefined;
        found.push({ path, mtimeMs: info.mtimeMs, size: info.size, ...(folder ? { cwd: folder } : {}) });
      }
    };
    for (const hash of workspaces ?? []) {
      const dir = join(this.workspaceStorage, hash, "chatSessions");
      const names = await readdir(dir).catch(() => [] as string[]);
      if (names.length > 0) await take(dir, names, () => workspaceFolder(join(this.workspaceStorage, hash)));
    }
    if (emptyNames) await take(empty, emptyNames);
    return found;
  }

  private statesFor(runId: string): Map<string, FileState> {
    let states = this.seen.get(runId);
    if (!states) {
      states = new Map();
      this.seen.set(runId, states);
    }
    return states;
  }
}

/** The folder a workspace storage entry belongs to, from VS Code's own `workspace.json`. */
async function workspaceFolder(dir: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
    const folder = isRecord(value) ? str(value.folder) : undefined;
    return folder?.startsWith("file://") ? fileURLToPath(folder) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where this run begins in a chat, or nothing when the chat is not this run's.
 *
 * A pasted prompt carries the marker in the person's own message, and the run
 * is that request on. A plugin handover never pastes one: the chat carries the
 * run's nonce in what the agent did after binding — the `anthill run` it ran,
 * the answer `bind_run` gave — and the run is that part on. Anything earlier
 * in the chat is earlier work.
 */
export function startOf(chat: Chat, marker: Marker, bound: boolean): { request: number; part: number } | undefined {
  for (const request of chat.requests) {
    if (!bound) {
      if (textCarriesMarker(request.text, marker)) return { request: request.index, part: -1 };
      continue;
    }
    // Only what the agent did names a bound run. The person's own message
    // quoting it — a pasted prompt, say — is not the binding's chat saying so.
    if (!request.raw.includes(marker.nonce)) continue;
    const raw = JSON.parse(request.raw) as Json;
    const parts = Array.isArray(raw.response) ? raw.response : [];
    const part = parts.findIndex((value) => {
      const text = JSON.stringify(value);
      return text.includes(marker.nonce) && text.includes(marker.runId);
    });
    if (part >= 0) return { request: request.index, part };
  }
  return undefined;
}

type Keyed = ObservationEventDraft & { key: string };

/** Everything this run's part of the chat says, in order, with stable times and keys. */
export function eventsOf(chat: Chat, from: { request: number; part: number }, marker: Marker, sessionId: string): Keyed[] {
  const out: Keyed[] = [];
  const base = { cli: "vscode" as const, source: "chat" as const, channel: CHANNEL, sessionId };

  for (const request of chat.requests) {
    if (request.index < from.request) continue;
    const key = (what: string) => `${request.id}:${what}`;

    if (request.index === from.request && from.part < 0) {
      out.push({ ...base, key: key("prompt"), at: iso(request.at), kind: "prompt.submit", title: "The workflow was pasted in" });
    }

    let clock = Math.max(request.at, request.respondedAt ?? 0);
    const finished = terminal(request);
    request.parts.forEach((part, index) => {
      if (part.kind === "tool" && part.at !== undefined && part.at > clock) clock = part.at;
      else clock += 1;
      if (request.index === from.request && index < from.part) return;
      const at = iso(clock);

      if (part.kind === "markdown") {
        // A part still being written is saved as far as it had got. It is
        // read once something follows it or the response is over, so the
        // feed never keeps half a sentence.
        if (index === request.parts.length - 1 && !finished) return;
        for (const blockId of parseStepMarkers(part.text, marker)) {
          out.push({ ...base, key: key(`${index}:step:${blockId}`), at, kind: "step.marker", title: "Step announced", detail: blockId, blockId });
        }
        const said = messageExcerpt(part.text, marker);
        if (said) {
          out.push({ ...base, key: key(`${index}:message`), at, kind: "message", title: "Message", detail: said, author: { kind: "main" } });
        }
        return;
      }

      if (part.kind === "tool") {
        const id = part.callId ?? `${request.id}:${index}`;
        out.push({ ...base, key: key(`${index}:tool`), at, kind: "tool.start", title: part.toolId, toolName: part.toolId, toolUseId: id });
        if (part.ended) {
          out.push({ ...base, key: key(`${index}:tool-end`), at, kind: "tool.end", title: "Tool finished", ok: part.ok, toolUseId: id });
        }
      }
    });

    const endedAt = iso(Math.max(request.completedAt ?? 0, clock + 1));
    if (request.state === MODEL_STATE.complete) {
      out.push({ ...base, key: key("end"), at: endedAt, kind: "turn.end", title: "The agent finished its turn" });
    } else if (request.state === MODEL_STATE.cancelled) {
      out.push({ ...base, key: key("end"), at: endedAt, kind: "notification", title: "Stopped by hand" });
    } else if (request.state === MODEL_STATE.failed) {
      out.push({ ...base, key: key("end"), at: endedAt, kind: "error", title: "VS Code recorded an error", detail: request.error ?? "The request failed." });
    }
  }
  return out;
}

/**
 * What the chat's last request says about now: in flight, waiting for the
 * person, stopped, failed, or finished and quiet long enough to call it done.
 * Repeated on every look while it holds, like the other observers' standing
 * facts; it stops the moment the chat moves on.
 */
function standing(
  chat: Chat,
  from: { request: number; part: number },
  sessionId: string,
  run: PendingRun,
  now: string,
  lastAt: string | undefined,
): Evidence[] {
  const last = chat.requests[chat.requests.length - 1];
  if (!last || last.index < from.request) return [];

  if (last.state === MODEL_STATE.failed) {
    return [{ kind: "failed", sessionId, channel: CHANNEL, at: now, detail: last.error ?? "VS Code recorded that the request failed." }];
  }
  if (last.state === MODEL_STATE.cancelled) {
    return [{
      kind: "interrupted",
      sessionId,
      channel: CHANNEL,
      at: lastAt ?? now,
      detail: "You stopped this chat. Anthill is no longer reading it; nothing was sent to the chat.",
    }];
  }
  const since = iso(last.at);
  const waiting = last.state === MODEL_STATE.needsInput || (!terminal(last) && last.parts.some((part) => part.kind === "tool" && part.waiting));
  if (waiting) {
    return Date.parse(now) - Date.parse(since) < TIMING.pendingTtlMs
      ? [{ kind: "awaiting", sessionId, at: now, since, detail: "VS Code is waiting for you to answer in the chat." }]
      : [];
  }
  if (!terminal(last)) {
    // In flight as of VS Code's last save, and believed only for as long as a
    // silent session is.
    return Date.parse(now) - Date.parse(since) <= TIMING.silenceTtlMs
      ? [{ kind: "working", sessionId, at: now, since, detail: "VS Code was still answering when it last saved the chat." }]
      : [];
  }

  const lastWord = [lastAt, run.lastObservedAt]
    .filter((value): value is string => Boolean(value))
    .reduce<string | undefined>((latest, value) => (latest && latest >= value ? latest : value), undefined);
  if (lastWord && Date.parse(now) - Date.parse(lastWord) > SETTLE_MS) {
    return [{ kind: "completed", sessionId, channel: CHANNEL, at: now, detail: "The chat finished its last request and has been quiet since." }];
  }
  return [];
}

/**
 * Whether a matched chat is still in the running to be *the* session, while
 * more than one carries the marker. One that ended or fell quiet has left.
 */
function contends(state: FileState, now: string): boolean {
  const last = state.chat?.requests[state.chat.requests.length - 1];
  if (!last) return true;
  if (last.state === MODEL_STATE.failed || last.state === MODEL_STATE.cancelled) return false;
  return Date.parse(now) - state.mtimeMs <= TIMING.activityTtlMs;
}
