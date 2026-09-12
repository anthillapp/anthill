/**
 * Recognising, and then following, a pi session the user started.
 *
 * pi writes every session to
 * `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<time>_<uuid>.jsonl`
 * as it goes. The file opens with a `session` record carrying the real
 * session id and the working directory, and the user's own message is
 * recorded as a `message` record of role `user` — which, for a pasted
 * Anthill prompt, is where the run marker lands. So detection needs no
 * cooperation from the agent and no hook installed anywhere: the evidence is
 * already there, in a record the tool owns.
 *
 * The same pass produces the activity the Live Session page shows. What is
 * read is deliberately narrow, and the narrowness is the point:
 *
 * - user messages: only whether they carry the run marker;
 * - assistant messages: `stopReason`, any Anthill step marker the agent
 *   printed, the token usage pi recorded, and one cut-down line of what it
 *   said to the person watching. `thinking` blocks are skipped by name before
 *   anything is read out of them, so the model's own working never reaches
 *   this file, let alone the page;
 * - `toolCall` blocks: the tool's name and its id. Never its output.
 * - `toolResult` records: only that the call came back, and whether it
 *   erred. Never the result body.
 *
 * `model_change`, `thinking_level_change`, `label` and `session_info`
 * records are settings and metadata, not the agent's work, and are skipped
 * by name before they count as activity.
 *
 * pi records its endings: an assistant message's `stopReason` of `stop` is a
 * natural turn end, `error` carries an `errorMessage`, and `aborted` says the
 * user stopped it. A turn ending is not a session ending, so a `stop` settles
 * into "completed" only after the same silence that would otherwise be
 * called "observation lost" — the same rule the Claude Code observer uses.
 *
 * A session file can outlive its runs: the same file holds earlier work.
 * Records written before the Anthill marker is pasted belong to that earlier
 * work, so when the first matching marker is found the run-local state (stop
 * reason, failure, settlement, usage, reported activity) is reset. An earlier
 * `error` must not fail the new run, and an earlier `stop` must not settle it
 * before pi has answered.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TIMING,
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
import { newCursor, readNewLines, type TailCursor } from "./tail.js";

/**
 * How quiet a matched session must be before its last turn counts as finished.
 *
 * The same silence that would otherwise be called "observation lost": long
 * enough that the difference between a turn ending and a session ending is
 * which way the last turn ended, not how fast the agent types.
 */
const SETTLE_MS = 5 * 60_000;

/** Stop reasons that mean the agent finished answering rather than paused. */
const TERMINAL_STOP = new Set(["stop"]);

/** Records that are settings or metadata, not the agent's work. */
const NON_WORK = new Set(["model_change", "thinking_level_change", "label", "session_info"]);

const CHANNEL = "pi:session";

type FileState = {
  /** How far into the session file this run has read. Bytes, always. */
  cursor: TailCursor;
  sessionId?: string;
  matched: boolean;
  /** The stop reason of the last assistant message, when the record says. */
  lastStopReason?: string;
  lastActivityAt?: string;
  /**
 * Assistant message ids whose usage has been taken.
 *
 * One message, one usage event — the session file writes each message once,
 * but a re-read of the file must not count it twice.
 */
  usageSeen: Set<string>;
  /** The activity timestamp already reported, so it is not reported twice. */
  reportedActivityAt?: string;
  settled: boolean;
  /** Set when the session recorded a failure; the run is then done. */
  failure?: string;
};

export class PiObserver implements LiveSessionObserver {
  readonly cli = "pi" as const;

  private readonly root: string;

  /** The root is injectable so the scanner can be tested against fixtures. */
  constructor(root: string = join(homedir(), ".pi", "agent", "sessions")) {
    this.root = root;
  }
  private readonly seen = new Map<string, Map<string, FileState>>();

  async detectCapabilities(): Promise<ObserverCapabilities> {
    const available = await stat(this.root).then(
      (info) => info.isDirectory(),
      () => false,
    );
    return {
      cli: this.cli,
      available,
      root: this.root,
      note: available
        ? "Anthill reads the session files pi writes for itself, including its own stop and error records."
        : "pi has written no local sessions on this machine, so there is nothing to read.",
      reportsCompletion: true,
      reportsFailure: true,
    };
  }

  forget(runId: string): void {
    this.seen.delete(runId);
  }

  async poll(run: PendingRun, now: string): Promise<PollResult> {
    const files = await this.candidates(run);
    if (files === undefined) {
      return {
        events: [],
        evidence: [
          {
            kind: "unobservable",
            channel: CHANNEL,
            at: now,
            detail: "pi has no local session records on this machine.",
          },
        ],
      };
    }

    const states = this.statesFor(run.anthillRunId);
    const evidence: Evidence[] = [];
    const events: ObservationEventDraft[] = [];
    /** Files that actually grew this poll. Nothing else counts as activity. */
    const grew = new Set<string>();

    for (const path of files) {
      const state =
        states.get(path) ??
        { cursor: newCursor(), matched: false, settled: false, usageSeen: new Set<string>() };
      states.set(path, state);

      const chunk = await readNewLines(path, state.cursor);
      if (!chunk.grew) continue;
      grew.add(path);
      scan(chunk.lines, state, now, { runId: run.anthillRunId, nonce: run.correlationNonce }, events);
    }

    const matched = [...states.entries()].filter(([, state]) => state.matched && state.sessionId);

    /*
      Two sessions carrying one marker.

      The same guard the other observers use, for the same reason: a second
      matching session must not quietly replace the first, and nothing is
      attributed while the two cannot be told apart. Ambiguity is judged over
      the candidates still *speaking*: a session that recorded an ending or
      fell as quiet as a session Anthill would no longer claim has left the
      contest.
    */
    const distinct = [...new Set(matched.map(([, state]) => state.sessionId as string))];

    let following = matched;
    if (distinct.length > 1) {
      const speaking = [
        ...new Set(
          matched
            .filter(([, state]) => contends(state, now))
            .map(([, state]) => state.sessionId as string),
        ),
      ];

      if (speaking.length > 1) {
        return {
          events: [],
          evidence: [{ kind: "ambiguous", sessionIds: speaking, channel: CHANNEL, at: now }],
        };
      }
      if (speaking.length === 0) {
        // Every candidate has gone quiet. Nothing can be attributed and there
        // is nothing new to say; the run keeps the state it has.
        return { events: [], evidence: [] };
      }
      // The field narrowed to one. Follow it — the loop below emits the match.
      following = matched.filter(([, state]) => state.sessionId === speaking[0]);
    }

    if (
      run.detectedSessionId !== undefined &&
      run.state === "ambiguous_match" &&
      following.length > 0 &&
      following[0][1].sessionId === run.detectedSessionId
    ) {
      // The contest resolved back to the session already being followed, whose
      // own activity cannot say so (it answers "alive", not "which").
      evidence.push({
        kind: "match",
        sessionId: run.detectedSessionId,
        confidence: "strong",
        channel: CHANNEL,
        at: now,
      });
    }

    for (const [path, state] of following) {
      const sessionId = state.sessionId as string;

      if (run.detectedSessionId !== sessionId) {
        evidence.push({
          kind: "match",
          sessionId,
          // The marker is in a record pi wrote itself, and carries the
          // per-copy nonce, so this is as good as it gets short of an id
          // Anthill assigned — which it cannot, since it launches nothing.
          confidence: "strong",
          channel: CHANNEL,
          at: state.lastActivityAt ?? now,
        });
      } else if (
        grew.has(path) &&
        state.lastActivityAt &&
        state.lastActivityAt !== state.reportedActivityAt
      ) {
        // Only new work is activity. A file can grow by records this observer
        // deliberately skips — settings changes, for one — and reporting
        // those as activity would keep a finished run looking alive.
        state.reportedActivityAt = state.lastActivityAt;
        evidence.push({ kind: "activity", sessionId, at: state.lastActivityAt });
      }

      if (state.failure) {
        evidence.push({
          kind: "failed",
          sessionId,
          channel: CHANNEL,
          at: now,
          detail: state.failure,
        });
        continue;
      }

      /*
        Silence measured across every channel, not just this file.

        The session's last word is the latest thing *anything* recorded about
        it, and `run.lastObservedAt` is one poll behind — which against a
        five-minute threshold does not matter — and it never runs ahead of the
        truth: it moves only when a channel actually reported something.
      */
      const lastWord = [state.lastActivityAt, run.lastObservedAt]
        .filter((value): value is string => Boolean(value))
        .reduce<string | undefined>(
          (latest, value) => (latest && latest >= value ? latest : value),
          undefined,
        );
      const quietFor = lastWord ? Date.parse(now) - Date.parse(lastWord) : 0;
      // A natural turn end plus a long silence is an ending. pi has no
      // delegation tool whose work would continue somewhere this file never
      // describes, so there is nothing extra to wait on here.
      if (
        !state.settled &&
        state.lastStopReason &&
        TERMINAL_STOP.has(state.lastStopReason) &&
        quietFor > SETTLE_MS
      ) {
        state.settled = true;
        evidence.push({
          kind: "completed",
          sessionId,
          channel: CHANNEL,
          at: now,
          detail: "The session finished its turn and has been quiet since.",
        });
      }

      // Whatever was pushed above already told the run how fresh this session
      // is. Recording that here is what stops the next poll from repeating it
      // as new activity.
      state.reportedActivityAt = state.lastActivityAt;
    }

    const owned =
      new Set(following.map(([, state]) => state.sessionId as string)).size === 1
        ? (following[0][1].sessionId as string)
        : run.detectedSessionId;
    return {
      evidence,
      events: owned ? events.filter((event) => event.sessionId === owned && isThisRun(event, run)) : [],
    };
  }

  /** Session files written since this run was created. */
  private async candidates(run: PendingRun): Promise<string[] | undefined> {
    const projects = await readdir(this.root).catch(() => undefined);
    if (projects === undefined) return undefined;

    // A minute of slack, because a session can be started a moment before the
    // copy finishes and clocks are not exact.
    const floor = Date.parse(run.createdAt) - 60_000;
    const paths: string[] = [];

    for (const project of projects) {
      const dir = join(this.root, project);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs >= floor) paths.push(path);
      }
    }
    return paths;
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

/**
 * Whether a matched candidate is still in the running to be *the* session.
 *
 * Used only while more than one candidate carries the marker. A session that
 * recorded an ending, or that has been quiet longer than Anthill would claim
 * any session for, has left the contest — its file staying on disk is a fact
 * about files, not about sessions.
 */
function contends(state: FileState, now: string): boolean {
  if (state.settled || state.failure) return false;
  if (!state.lastActivityAt) return true;
  return Date.parse(now) - Date.parse(state.lastActivityAt) <= TIMING.activityTtlMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Clear the run-local state when the first matching marker is found.
 *
 * A session file can hold earlier work. Records written before the marker —
 * an earlier `error`, an earlier `stop` — belong to that earlier work and
 * must not fail or settle the run that has not even been pasted in yet.
 */
function resetRunState(state: FileState): void {
  state.lastStopReason = undefined;
  state.failure = undefined;
  state.settled = false;
  state.usageSeen.clear();
  state.reportedActivityAt = undefined;
}

/**
 * Read only what is needed, from one chunk of newly written session file.
 *
 * A free function taking the marker as an argument, so nothing about which run
 * is being looked for can leak between polls.
 */
function scan(
  lines: string[],
  state: FileState,
  now: string,
  marker: { runId: string; nonce: string },
  events: ObservationEventDraft[],
): void {
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Settings and metadata, skipped by name before anything is read out of
    // them, so they do not count as activity.
    if (NON_WORK.has(str(row.type) ?? "")) continue;

    const at = str(row.timestamp) ?? now;
    state.lastActivityAt = at;

    if (row.type === "session") {
      const id = str(row.id);
      if (id) state.sessionId = id;
      events.push({
        at,
        cli: "pi",
        source: "session",
        channel: CHANNEL,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        kind: "session.start",
        title: "Session started",
        ...(str(row.cwd) ? { detail: str(row.cwd) as string } : {}),
      });
      continue;
    }

    if (row.type !== "message") continue;
    const message = isRecord(row.message) ? row.message : undefined;
    if (!message) continue;

    const base = {
      at,
      cli: "pi" as const,
      source: "session" as const,
      channel: CHANNEL,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };

    if (message.role === "user") {
      const carries = (value: unknown) => typeof value === "string" && textCarriesMarker(value, marker);
      const matchedOnce = () => {
        // The first marker this run has seen. Records before it are the
        // session's earlier work, so the run-local state is cleared then.
        if (!state.matched) resetRunState(state);
        state.matched = true;
      };
      if (carries(message.content)) {
        matchedOnce();
        events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
      } else if (Array.isArray(message.content)) {
        // The user's content may be a string or an array of text blocks.
        for (const block of message.content) {
          if (isRecord(block) && carries(block.text)) {
            matchedOnce();
            events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
          }
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      // A tool result closes the call that opened it. Only the outcome is
      // read; the result body stays where pi wrote it.
      events.push({
        ...base,
        kind: "tool.end",
        title: "Tool finished",
        ok: message.isError !== true,
        ...(str(message.toolCallId) ? { toolUseId: str(message.toolCallId) as string } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      state.lastStopReason = str(message.stopReason);
      state.settled = false;

      // One message, one usage event, keyed on the id the file itself uses,
      // so a re-read cannot count it twice.
      const usage = isRecord(message.usage) ? message.usage : undefined;
      const messageId = str(row.id);
      if (usage && messageId && !state.usageSeen.has(messageId)) {
        state.usageSeen.add(messageId);
        const num = (value: unknown) => (typeof value === "number" ? value : 0);
        events.push({
          ...base,
          kind: "usage",
          title: "Token usage recorded",
          toolUseId: messageId,
          tokens: {
            // Fresh input and cache traffic both count as read.
            in: num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite),
            out: num(usage.output),
          },
        });
      }

      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;

        // The model's own working. It stops here, and no branch below can see it.
        if (block.type === "thinking") continue;

        if (block.type === "text") {
          const text = str(block.text) ?? "";
          for (const blockId of parseStepMarkers(text, marker)) {
            events.push({
              ...base,
              kind: "step.marker",
              title: "Step announced",
              detail: blockId,
              blockId,
            });
          }
          // What the agent actually said. A message whose whole content was the
          // step marker leaves nothing behind and produces no card, which is
          // right: the announcement is already its own event.
          const said = messageExcerpt(text, marker);
          if (said) {
            // pi's assistant records are the session's own; the file has no
            // subagent concept, so there is no other author this could be.
            events.push({ ...base, kind: "message", title: "Message", detail: said, author: { kind: "main" } });
          }
          continue;
        }

        if (block.type === "toolCall") {
          const name = str(block.name) ?? "a tool";
          const id = str(block.id);
          events.push({
            ...base,
            kind: "tool.start",
            title: name,
            toolName: name,
            ...(id ? { toolUseId: id } : {}),
          });
        }
      }

      // A recorded failure is a failure, not a silence to settle over.
      if (state.lastStopReason === "error") {
        state.failure = str(message.errorMessage) ?? "pi recorded an error.";
        events.push({
          ...base,
          kind: "error",
          title: "pi recorded an error",
          detail: state.failure,
        });
      } else if (state.lastStopReason === "aborted") {
        state.failure = "The session was aborted.";
        events.push({
          ...base,
          kind: "error",
          title: "The session was aborted",
          detail: state.failure,
        });
      }

      /*
        The turn ending, said out loud.

        A natural stop is written once per yield — an assistant message that is
        about to call a tool carries `toolUse` instead — so this is one event
        per time the agent actually stopped, not one per record. The message
        id carries the dedup where the record has one; where it does not, the
        timestamp and title in the fingerprint do.
      */
      if (state.lastStopReason && TERMINAL_STOP.has(state.lastStopReason)) {
        events.push({
          ...base,
          kind: "turn.end",
          title: "The agent finished its turn",
          ...(messageId ? { toolUseId: messageId } : {}),
        });
      }
    }
  }
}
