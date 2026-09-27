/**
 * Recognising a Codex session the user started themselves.
 *
 * Codex writes a rollout file per session under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. It opens with a
 * `session_meta` record carrying the real session id, and it records the user's
 * own message as a `response_item` — which is where a pasted Anthill prompt
 * puts the marker. Unlike Claude Code, Codex also writes `task_complete`, so a
 * finished turn is a fact Anthill reads rather than an absence it infers.
 *
 * `response_item` records of type `reasoning` are skipped by name before
 * anything is read out of them. Codex stores the model's own working in those
 * records; Anthill has no use for it and no code here that touches it.
 *
 * A session can own more than one file: Codex opens another for each thread
 * it runs under the session — the "Approve for me" reviewer, one per command
 * it judges — and writes the parent's `session_id` into it. Those are read
 * past and never reported; only the session's own file speaks for it.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TIMING,
  boundSessionId,
  messageExcerpt,
  parseDoneMarker,
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

const CHANNEL = "codex:rollout";

type FileState = {
  cursor: TailCursor;
  sessionId?: string;
  /**
   * A thread that is not the session's own — Codex's "Approve for me"
   * reviewer, for one — whose file carries the parent's `session_id` but
   * speaks for nobody Anthill is following. Read past, never reported (ANT-129).
   */
  subthread: boolean;
  matched: boolean;
  lastActivityAt?: string;
  /** The activity timestamp already reported, so it is not reported twice. */
  reportedActivityAt?: string;
  /** Set once `task_complete` has been seen and reported. */
  completedAt?: string;
  reportedComplete: boolean;
  failure?: string;
  /**
   * The last step announced in this file, and where it was read: the reply
   * text, or the output of a command the session ran. The same announcement
   * seen in both places is one announcement, not a second pass (ANT-147).
   */
  lastStep?: { blockId: string; from: "reply" | "command" };
  /**
   * The session's opening record, held until the file turns out to be this
   * run's. It is read in the first poll that sees the file, and the marker
   * may only arrive in a later one — when the poll's events were dropped for
   * not belonging to any matched session, the opening went with them, and a
   * full re-read after a restart then appended it after `task_complete`
   * (ANT-159). Held, it is reported once, whichever read the marker lands in.
   */
  opening?: ObservationEventDraft;
  openingReported?: boolean;
  /** The done line already reported, so a reply and a command echoing it are one ending. */
  doneReported?: boolean;
};

export class CodexObserver implements LiveSessionObserver {
  readonly cli = "codex" as const;

  private readonly root: string;

  /** The root is injectable so the scanner can be tested against fixtures. */
  constructor(root: string = join(homedir(), ".codex", "sessions")) {
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
        ? "Anthill reads the rollout files Codex writes for itself, including its own turn-completion record."
        : "Codex has written no local sessions on this machine, so there is nothing to read.",
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
            detail: "Codex has no local session records on this machine.",
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
        states.get(path) ?? { cursor: newCursor(), subthread: false, matched: false, reportedComplete: false };
      states.set(path, state);

      const chunk = await readNewLines(path, state.cursor);
      if (!chunk.grew) continue;
      grew.add(path);
      scan(chunk.lines, state, now, { runId: run.anthillRunId, nonce: run.correlationNonce }, events);
    }

    // Only the opening, never the history before the marker: a session reused
    // for this run has earlier turns that were not this run's to report.
    for (const state of states.values()) {
      if (state.matched && state.opening && !state.openingReported) {
        state.openingReported = true;
        events.push(state.opening);
      }
    }

    /*
      The session a binding named.

      A handover made through the exchange never pastes a prompt: the marker
      reaches the rollout only inside the `anthill` commands the agent runs,
      never in a user message, so nothing below would ever match the session's
      own file. What did match was the "Approve for me" reviewer's thread,
      whose request quotes the command — and every verdict it gave ended in
      `task_complete`, so the page said "Session finished" while the agent
      was still working (ANT-129). Same answer the Claude Code observer gives:
      the harness said which session it is in, and that is the better evidence.
    */
    const named = boundSessionId(run);
    if (named) {
      for (const state of states.values()) {
        if (state.sessionId === named) state.matched = true;
      }
    }

    const matched = [...states.entries()].filter(([, state]) => state.matched && state.sessionId);

    /*
      Two sessions carrying one marker.

      This guard used to be skipped once a session had been chosen, so a second
      matching session could quietly replace the first and the tracked id could
      alternate between them from poll to poll. Which of the two the workflow's
      steps are coming from is exactly the question Anthill cannot answer, and
      having already answered it once is not a reason to stop asking.

      No events are reported while it holds: attributing one session's work to
      the graph when it might be the other's is the specific mistake this state
      exists to prevent.

      Ambiguity is judged over the candidates still *speaking*, not over files
      on disk — transcripts outlive their sessions, so a file is forever and a
      contest of files could never end. A candidate leaves the field when its
      session records an ending or falls as quiet as a session Anthill would no
      longer claim (the same threshold the product already uses for that). Once
      one candidate remains, the observer says so; if it writes again later it
      re-enters the contest, and the ambiguity honestly returns.
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
        // deliberately skips — Codex's own reasoning, for one — and reporting
        // that as activity would keep a finished run looking alive.
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

      if (state.completedAt && !state.reportedComplete) {
        state.reportedComplete = true;
        evidence.push({
          kind: "completed",
          sessionId,
          channel: CHANNEL,
          at: state.completedAt,
          detail: "Codex recorded that the turn completed.",
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

  /** Rollout files written since this run was created. */
  private async candidates(run: PendingRun): Promise<string[] | undefined> {
    const years = await readdir(this.root).catch(() => undefined);
    if (years === undefined) return undefined;

    const floor = Date.parse(run.createdAt) - 60_000;
    const paths: string[] = [];

    // The tree is year/month/day, so only the days at or after the run's own
    // date can hold it. Walking the whole history would be pointless work.
    for (const year of years) {
      const months = await readdir(join(this.root, year)).catch(() => [] as string[]);
      for (const month of months) {
        const days = await readdir(join(this.root, year, month)).catch(() => [] as string[]);
        for (const day of days) {
          const dir = join(this.root, year, month, day);
          const names = await readdir(dir).catch(() => [] as string[]);
          for (const name of names) {
            if (!name.endsWith(".jsonl")) continue;
            const path = join(dir, name);
            const info = await stat(path).catch(() => undefined);
            if (info && info.mtimeMs >= floor) paths.push(path);
          }
        }
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
 * Same rule as the Claude Code observer, with Codex's advantage: it records
 * its endings, so a finished or failed candidate leaves the contest on its own
 * word rather than by inference.
 */
function contends(state: FileState, now: string): boolean {
  if (state.completedAt || state.failure) return false;
  if (!state.lastActivityAt) return true;
  return Date.parse(now) - Date.parse(state.lastActivityAt) <= TIMING.activityTtlMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Every text fragment in a Codex message's content array, joined. */
function messageText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((block) => (isRecord(block) ? str(block.text) : undefined))
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

/**
 * The text a tool call gave back. `function_call_output` carries a string;
 * `custom_tool_call_output` carries an array of `{ type, text }` parts, and
 * the exec tool nests the command's own stdout as JSON inside one of them.
 * The markers are searched as text, so the JSON escapes are undone first.
 */
function outputText(output: unknown): string {
  const parts = typeof output === "string"
    ? [output]
    : Array.isArray(output)
      ? output.map((part) => (isRecord(part) ? str(part.text) : undefined)).filter((text): text is string => text !== undefined)
      : isRecord(output) && str(output.content) ? [str(output.content) as string] : [];
  return parts.join("\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/**
 * Every step the text announces, as events. An announcement repeated from the
 * other place — printed by a command and then echoed in the reply, or the
 * reverse — is dropped, because the metrics count each announcement as a new
 * pass of the step and a loop must not appear where none happened.
 */
function announceSteps(
  text: string,
  from: "reply" | "command",
  state: FileState,
  marker: { runId: string; nonce: string },
  base: Omit<ObservationEventDraft, "kind" | "title">,
  events: ObservationEventDraft[],
): void {
  for (const blockId of parseStepMarkers(text, marker)) {
    if (state.lastStep?.blockId === blockId && state.lastStep.from !== from) continue;
    state.lastStep = { blockId, from };
    events.push({ ...base, kind: "step.marker", title: "Step announced", detail: blockId, blockId });
  }
}

/**
 * The harness's own done line, printed in a reply or by a command. Reported
 * once per file: an agent that prints it and then repeats it in its summary
 * has finished once.
 */
function announceDone(
  text: string,
  state: FileState,
  marker: { runId: string; nonce: string },
  base: Omit<ObservationEventDraft, "kind" | "title">,
  events: ObservationEventDraft[],
): void {
  if (state.doneReported || !parseDoneMarker(text, marker)) return;
  state.doneReported = true;
  events.push({
    ...base,
    kind: "session.end",
    title: "The harness reported the work as finished",
    author: { kind: "main" },
    completion: "done",
  });
}

/**
 * Read only what matters: the session id, the user's message, any step the
 * agent announced, tool calls, the turn-completion record, and errors.
 */
function scan(
  lines: string[],
  state: FileState,
  now: string,
  marker: { runId: string; nonce: string },
  events: ObservationEventDraft[],
): void {
  for (const line of lines) {
    // Nothing a sub-thread writes is the session's own doing (ANT-129).
    if (state.subthread) return;
    if (!line.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (!payload) continue;

    // Skipped by name, before anything is read out of it.
    if (payload.type === "reasoning") continue;

    // A line with no time of its own does not move the activity clock; see
    // the Claude Code observer, where undated bookkeeping revived stopped
    // sessions. Codex stamps every rollout line, so here it is a guard.
    const stamped = str(row.timestamp);
    const at = stamped ?? state.lastActivityAt ?? now;

    if (row.type === "session_meta") {
      /*
        `session_id` is the session; `id` is this thread. They differ in a
        file Codex opens for a thread of its own under the session — the
        "Approve for me" reviewer writes one per command it judges, and names
        the parent in `parent_thread_id`. Such a file carries the session's
        id without being the session: its user message is the approval
        request, its assistant message is the verdict, and its `task_complete`
        is the verdict's, not the session's.
      */
      const session = str(payload.session_id);
      const thread = str(payload.id);
      if (str(payload.parent_thread_id) || (session && thread && thread !== session)) {
        state.subthread = true;
        return;
      }
      const id = session ?? thread;
      if (id) state.sessionId = id;
      if (stamped) state.lastActivityAt = stamped;
      state.opening = {
        at,
        cli: "codex",
        source: "rollout",
        channel: CHANNEL,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        kind: "session.start",
        title: "Session started",
        ...(str(payload.cli_version) ? { detail: `Codex ${str(payload.cli_version)}` } : {}),
      };
      continue;
    }

    if (stamped) state.lastActivityAt = stamped;
    const base = {
      at,
      cli: "codex" as const,
      source: "rollout" as const,
      channel: CHANNEL,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };

    if (row.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") {
        if (textCarriesMarker(messageText(payload), marker)) {
          state.matched = true;
          events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
        }
        continue;
      }
      if (payload.role === "assistant") {
        const text = messageText(payload);
        announceSteps(text, "reply", state, marker, base, events);
        announceDone(text, state, marker, base, events);
        // And one cut-down line of what it said. Codex writes its reasoning to
        // a different record type entirely, which this branch never sees.
        const said = messageExcerpt(text, marker);
        if (said) {
          // A rollout's assistant messages are the session's own. Codex has no
          // subagent concept in these records, so there is no other author
          // this could be — and nothing to be unsure about.
          events.push({
            ...base,
            kind: "message",
            title: "Message",
            detail: said,
            author: { kind: "main" },
          });
        }
      }
      continue;
    }

    if (row.type === "response_item") {
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = str(payload.name) ?? "a tool";
        events.push({
          ...base,
          kind: "tool.start",
          title: name,
          toolName: name,
          ...(str(payload.call_id) ? { toolUseId: str(payload.call_id) as string } : {}),
        });
      }
      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        events.push({
          ...base,
          kind: "tool.end",
          title: "Tool finished",
          ...(str(payload.call_id) ? { toolUseId: str(payload.call_id) as string } : {}),
        });
        // Asked to "print" a marker, an agent whose only way to print is a
        // shell prints it with one: Codex Desktop writes `printf 'ANTHILL-STEP
        // …'`, and the line exists only in the command's output (ANT-147).
        // Only the output is read — the command itself merely names the line,
        // and a command that fails to print it has not announced anything.
        announceSteps(outputText(payload.output), "command", state, marker, base, events);
        announceDone(outputText(payload.output), state, marker, base, events);
      }
      continue;
    }

    if (row.type === "event_msg") {
      // Codex writes a running token count; `last_token_usage` is the slice
      // since the previous count, which is what makes the events summable.
      if (payload.type === "token_count") {
        const info = isRecord(payload.info) ? payload.info : undefined;
        const last = isRecord(info?.last_token_usage) ? info.last_token_usage : undefined;
        if (last) {
          const num = (value: unknown) => (typeof value === "number" ? value : 0);
          events.push({
            ...base,
            kind: "usage",
            title: "Token usage recorded",
            tokens: {
              in: num(last.input_tokens) + num(last.cached_input_tokens),
              out: num(last.output_tokens),
            },
          });
        }
      }
      if (payload.type === "task_complete") {
        state.completedAt = at;
        state.reportedComplete = false;
        // Codex's own word that the task is over — typed, so the fold does not
        // have to recognise it by where it came from (ANT-158).
        events.push({ ...base, kind: "turn.end", title: "Codex finished the turn", completion: "task_complete" });
      }
      if (payload.type === "error" || payload.type === "stream_error") {
        const message = str(payload.message) ?? "Codex recorded an error.";
        state.failure = message;
        events.push({ ...base, kind: "error", title: "Codex recorded an error", detail: message });
      }
    }
  }
}
