/**
 * VS Code's agent as the Copilot CLI runs it.
 *
 * Since VS Code 1.140 a chat in Agent mode runs, by default, in the Agent
 * Host's Copilot harness rather than in the workbench, and the record it
 * keeps is the Copilot CLI's own:
 * `~/.copilot/session-state/<session id>/events.jsonl`, with the session's
 * folder in `workspace.yaml` beside it. Unlike the workbench's chat files it
 * is written as the work happens and only ever appended to, so it is tailed,
 * and every line carries its own time.
 *
 * Each line is `{type, data, id, timestamp, parentId}`. What is read, and
 * nothing more:
 *
 * - `session.start`: that the session began;
 * - `user.message`: only whether `data.content` carries the run marker;
 * - `assistant.message`: `data.content`, for step markers and one cut-down
 *   line of what the agent said. The model's own working rides on the same
 *   line as `reasoningOpaque`, `encryptedContent` and `reasoningBlocks`, and
 *   is never read;
 * - `tool.execution_start` / `tool.execution_complete`: the tool's name, the
 *   call's id, and whether it succeeded. Never its arguments or its result —
 *   except that a bound run's nonce is looked for in the line, which is the one
 *   way a plugin handover's session can be told apart;
 * - `permission.requested` / `permission.completed`: that the person is being
 *   asked something, and when that ends;
 * - `assistant.turn_start` / `assistant.turn_end`: a model round beginning and
 *   ending. A request is over when its last round has ended and the session
 *   has gone quiet.
 *
 * No stop or failure record has been seen in a real file yet; a line whose
 * type names an abort or an error is read as one, and the rest as nothing.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TIMING,
  isAnthillTool,
  messageExcerpt,
  parseStepMarkers,
  textCarriesMarker,
  type Evidence,
  type PendingRun,
} from "@anthill/live";

import { isThisRun, type ObservationEventDraft, type PollResult } from "./types.js";
import { newCursor, readNewLines, type TailCursor } from "./tail.js";

export const COPILOT_CHANNEL = "vscode:copilot";

/** The same silence the other observers wait out before calling a finished turn the end. */
const SETTLE_MS = 5 * 60_000;

export function copilotSessionRoot(home: string = homedir()): string {
  return join(process.env.COPILOT_HOME || join(home, ".copilot"), "session-state");
}

type Marker = { runId: string; nonce: string };

type SessionState = {
  cursor: TailCursor;
  sessionId: string;
  cwd?: string;
  matched: boolean;
  lastActivityAt?: string;
  reportedActivityAt?: string;
  /** Model rounds open now: started and not yet ended. */
  openTurns: number;
  lastTurnEndAt?: string;
  openTools: Map<string, { at: string; toolName?: string }>;
  /** Questions put to the person and not yet answered, by request id. */
  asking: Map<string, string>;
  failure?: string;
  interruptedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The session's folder, from the `cwd:` line of its `workspace.yaml`. */
async function sessionFolder(dir: string): Promise<string | undefined> {
  const text = await readFile(join(dir, "workspace.yaml"), "utf8").catch(() => "");
  return /^cwd:\s*(.+?)\s*$/m.exec(text)?.[1];
}

export class CopilotSessionReader {
  private readonly seen = new Map<string, Map<string, SessionState>>();

  constructor(private readonly root: string = copilotSessionRoot()) {}

  async available(): Promise<boolean> {
    return stat(this.root).then((info) => info.isDirectory(), () => false);
  }

  forget(runId: string): void {
    this.seen.delete(runId);
  }

  /**
   * The Copilot session a plugin handover is working in: the one whose agent
   * ran or was answered with this run's nonce. One session, or no answer.
   */
  async locate(run: PendingRun): Promise<string | undefined> {
    const states = await this.read(run, true);
    const found = new Set([...states.values()].filter((state) => state.matched).map((state) => state.sessionId));
    return found.size === 1 ? [...found][0] : undefined;
  }

  /**
   * What this run's session said since the last look, when one is this run's.
   * `bound` names the session a binding resolved to; until there is one, a
   * plugin run's session is not followed here.
   */
  async poll(run: PendingRun, now: string, bound: string | undefined): Promise<(PollResult & { sessionId: string }) | undefined> {
    const plugin = run.exchange?.sessionId !== undefined;
    const events: ObservationEventDraft[] = [];
    const states = await this.read(run, plugin, events);
    const matched = [...states.values()].filter((state) => state.matched && (!plugin || state.sessionId === bound));
    if (matched.length === 0) return undefined;
    if (matched.length > 1) {
      return {
        sessionId: matched[0]!.sessionId,
        events: [],
        evidence: [{ kind: "ambiguous", sessionIds: matched.map((state) => state.sessionId), channel: COPILOT_CHANNEL, at: now }],
      };
    }

    const [state] = matched as [SessionState];
    const sessionId = state.sessionId;
    const own = events.filter((event) => event.sessionId === sessionId && isThisRun(event, run));
    const evidence: Evidence[] = [];

    if (run.detectedSessionId !== sessionId) {
      evidence.push({
        kind: "match",
        sessionId,
        confidence: "strong",
        channel: COPILOT_CHANNEL,
        at: state.lastActivityAt ?? now,
        ...(state.cwd ? { cwd: state.cwd } : {}),
      });
    } else if (own.length > 0 && state.lastActivityAt && state.lastActivityAt !== state.reportedActivityAt) {
      evidence.push({
        kind: "activity",
        sessionId,
        at: state.lastActivityAt,
        channel: COPILOT_CHANNEL,
        // Only the work's own tools resume a finished run; Anthill's own and
        // the closing words do not (ANT-188, ANT-215).
        resumes: own.some((event) => event.kind === "tool.start" && !isAnthillTool(event.toolName)),
      });
    }
    state.reportedActivityAt = state.lastActivityAt;
    evidence.push(...standing(state, sessionId, run, now));
    return { sessionId, evidence, events: own };
  }

  /** Read every candidate session's new lines into its state; events go to `out` when given. */
  private async read(run: PendingRun, bound: boolean, out?: ObservationEventDraft[]): Promise<Map<string, SessionState>> {
    let states = this.seen.get(run.anthillRunId);
    if (!states) {
      states = new Map();
      this.seen.set(run.anthillRunId, states);
    }
    const names = await readdir(this.root).catch(() => [] as string[]);
    const floor = Date.parse(run.createdAt) - 60_000;
    const marker = { runId: run.anthillRunId, nonce: run.correlationNonce };
    for (const name of names) {
      const dir = join(this.root, name);
      const path = join(dir, "events.jsonl");
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs < floor) continue;
      let state = states.get(name);
      if (!state) {
        state = { cursor: newCursor(), sessionId: name, matched: false, openTurns: 0, openTools: new Map(), asking: new Map() };
        const cwd = await sessionFolder(dir);
        if (cwd) state.cwd = cwd;
        states.set(name, state);
      }
      const chunk = await readNewLines(path, state.cursor);
      if (!chunk.grew) continue;
      scan(chunk.lines, state, marker, bound, out ?? []);
    }
    return states;
  }
}

/**
 * Read only what is needed from a chunk of new lines. Lines before the run
 * began are the session's earlier work, and only move its clock.
 */
function scan(lines: string[], state: SessionState, marker: Marker, bound: boolean, events: ObservationEventDraft[]): void {
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = str(row.type) ?? "";
    const data = isRecord(row.data) ? row.data : {};
    const at = str(row.timestamp);
    if (!at) continue;

    if (!state.matched) {
      const starts = bound
        ? /^(tool\.execution_(start|complete)|external_tool\.)/.test(type) && line.includes(marker.nonce) && line.includes(marker.runId)
        : type === "user.message" && typeof data.content === "string" && textCarriesMarker(data.content, marker);
      if (!starts) continue;
      state.matched = true;
    }

    // Bookkeeping and the session's own metadata are not the agent's work.
    if (type.startsWith("hook.") || type.startsWith("session.usage") || type === "system.message") continue;
    state.lastActivityAt = at;
    const base = { at, cli: "vscode" as const, source: "session" as const, channel: COPILOT_CHANNEL, sessionId: state.sessionId };

    if (type === "user.message") {
      if (typeof data.content === "string" && textCarriesMarker(data.content, marker)) {
        events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
      }
      state.interruptedAt = undefined;
      continue;
    }
    if (type === "assistant.turn_start") {
      state.openTurns += 1;
      continue;
    }
    if (type === "assistant.turn_end") {
      state.openTurns = Math.max(0, state.openTurns - 1);
      state.lastTurnEndAt = at;
      continue;
    }
    if (type === "assistant.message") {
      // `content` only. The reasoning fields on the same line are left unread.
      const text = typeof data.content === "string" ? data.content : "";
      const messageId = str(data.messageId);
      for (const blockId of parseStepMarkers(text, marker)) {
        events.push({ ...base, kind: "step.marker", title: "Step announced", detail: blockId, blockId });
      }
      const said = messageExcerpt(text, marker);
      if (said) {
        events.push({
          ...base,
          kind: "message",
          title: "Message",
          detail: said,
          author: { kind: "main" },
          ...(messageId ? { toolUseId: messageId } : {}),
        });
      }
      continue;
    }
    if (type === "tool.execution_start") {
      const id = str(data.toolCallId);
      const name = str(data.toolName) ?? "a tool";
      if (id) state.openTools.set(id, { at, toolName: name });
      events.push({ ...base, kind: "tool.start", title: name, toolName: name, ...(id ? { toolUseId: id } : {}) });
      continue;
    }
    if (type === "tool.execution_complete") {
      const id = str(data.toolCallId);
      if (id) state.openTools.delete(id);
      events.push({ ...base, kind: "tool.end", title: "Tool finished", ok: data.success !== false, ...(id ? { toolUseId: id } : {}) });
      continue;
    }
    if (type === "permission.requested") {
      const id = str(data.requestId);
      if (id) state.asking.set(id, at);
      continue;
    }
    if (type === "permission.completed") {
      const id = str(data.requestId);
      if (id) state.asking.delete(id);
      continue;
    }
    if (/abort|cancel/i.test(type)) {
      state.interruptedAt = at;
      state.openTools.clear();
      state.asking.clear();
      state.openTurns = 0;
      events.push({ ...base, kind: "notification", title: "Stopped by hand" });
      continue;
    }
    if (/(^|\.)error$/i.test(type)) {
      state.failure = str(data.message) ?? "The Copilot session recorded an error.";
      state.openTools.clear();
      events.push({ ...base, kind: "error", title: "The session recorded an error", detail: state.failure });
    }
  }
}

/** What the session's state says about now. Repeated on every look while it holds. */
function standing(state: SessionState, sessionId: string, run: PendingRun, now: string): Evidence[] {
  if (state.failure) return [{ kind: "failed", sessionId, channel: COPILOT_CHANNEL, at: now, detail: state.failure }];
  if (state.interruptedAt && state.interruptedAt === state.lastActivityAt) {
    return [{
      kind: "interrupted",
      sessionId,
      channel: COPILOT_CHANNEL,
      at: state.interruptedAt,
      detail: "You stopped this chat. Anthill is no longer reading it; nothing was sent to the chat.",
    }];
  }
  const asked = [...state.asking.values()].sort()[0];
  if (asked && Date.parse(now) - Date.parse(asked) < TIMING.pendingTtlMs) {
    return [{ kind: "awaiting", sessionId, at: now, since: asked, detail: "VS Code is asking you something in the chat." }];
  }
  const open = [...state.openTools.entries()].filter(([id, call]) => {
    if (Date.parse(now) - Date.parse(call.at) <= TIMING.silenceTtlMs) return true;
    state.openTools.delete(id);
    return false;
  });
  if (open.length > 0) {
    const [, newest] = open.sort((a, b) => (a[1].at < b[1].at ? 1 : -1))[0]!;
    return [{
      kind: "working",
      sessionId,
      at: now,
      since: newest.at,
      ...(newest.toolName ? { detail: `${newest.toolName} has been running since ${newest.at}.` } : {}),
    }];
  }
  if (state.openTurns === 0 && state.lastTurnEndAt) {
    const lastWord = [state.lastActivityAt, run.lastObservedAt]
      .filter((value): value is string => Boolean(value))
      .reduce<string | undefined>((latest, value) => (latest && latest >= value ? latest : value), undefined);
    if (lastWord && Date.parse(now) - Date.parse(lastWord) > SETTLE_MS) {
      return [{ kind: "completed", sessionId, channel: COPILOT_CHANNEL, at: now, detail: "The chat finished its last request and has been quiet since." }];
    }
  }
  return [];
}
