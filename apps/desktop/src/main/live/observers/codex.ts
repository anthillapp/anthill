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
  parseStepTag,
  textCarriesMarker,
  type Evidence,
  type PendingRun,
} from "@anthill/live";

import {
  isThisRun,
  type LiveSessionObserver,
  type ObservationEventDraft,
  type ObservationContext,
  type ObserverCapabilities,
  type PollResult,
  type ReportedProgress,
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
  /**
   * When the person pressed Stop: Codex's `turn_aborted`, the only record of
   * it. A stop fires nothing else, so without it the step went on "Working"
   * and the session "Live" for as long as the window stayed open (ANT-208).
   */
  interruptedAt?: string;
  /**
   * When the session ended its turn at an Approval Gate with nothing done:
   * the gate's question asked, the answer not given. Codex writes
   * `task_complete` there as after every turn, and that is not the session
   * finishing (ANT-210). Cleared by the next turn starting.
   */
  awaitingAt?: string;
  reportedComplete: boolean;
  failure?: string;
  /**
   * The last step announced in this file, and where it was read: the reply
   * text, or the output of a command the session ran. The same announcement
   * seen in both places is one announcement, not a second pass (ANT-147).
   */
  lastStep?: { blockId: string; from: "reply" | "command"; at: string };
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
  /**
   * A subagent's thread: Codex writes one per `spawn_agent`, carrying the
   * session's id and the path the spawn gave it (ANT-171). Its work is the
   * session's work, done through that agent — read, and signed as the agent's.
   */
  delegate?: { path: string; name: string };
  /** Records read from this file so far. */
  linesRead?: number;
  /**
   * Where a subagent's own record begins. Codex starts a subagent's file with
   * a copy of the parent thread's history — its session record, its messages,
   * step tags and all, stamped with the subagent's start — and says where the
   * copy ends in `subagent_history_start_ordinal`, counted in the `ordinal`
   * every record carries. Read as the subagent's,
   * the copied messages re-entered steps long finished ("pass 3" on a gate)
   * and named the wrong step for the subagent's work (ANT-211).
   */
  ownFrom?: number;
  /**
   * Inside the copied history of a subagent's file whose record gives no
   * ordinal: from the parent's session record until the subagent's own
   * settings are applied.
   */
  inheriting?: boolean;
  /** The calls this file made, by call id: which were `spawn_agent`. */
  spawnCalls?: Set<string>;
};

/** Where a subagent's events wait until the spawn that started it is known. */
const PENDING_SPAWN = "agent-path:";

export class CodexObserver implements LiveSessionObserver {
  readonly cli = "codex" as const;

  private readonly root: string;

  /** The root is injectable so the scanner can be tested against fixtures. */
  constructor(root: string = join(homedir(), ".codex", "sessions")) {
    this.root = root;
  }
  private readonly seen = new Map<string, Map<string, FileState>>();
  /**
   * Per run, the call that spawned each subagent, by the agent path the spawn
   * returned — `{"task_name":"/root/developer_a"}` — which is the path the
   * subagent's own thread names itself by (ANT-171).
   */
  private readonly spawned = new Map<string, Map<string, string>>();

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
    this.spawned.delete(runId);
  }

  async poll(run: PendingRun, now: string, context?: ObservationContext): Promise<PollResult> {
    const files = await this.candidates(run);
    /*
      No sessions folder yet. That is a CLI that has not run a session on this
      machine, and its first one creates the folder: not a CLI Anthill cannot
      read. Reported as unobservable, it cut the wait for a session to two
      minutes and then called the copied prompt a failed session, for exactly
      the person trying the CLI for the first time (ANT-212). Nothing to say
      yet; the ordinary wait applies.
    */
    if (files === undefined) return { events: [], evidence: [] };

    const states = this.statesFor(run.anthillRunId);
    const gates = new Set((run.steps ?? []).filter((step) => step.gate).map((step) => step.id));
    let spawns = this.spawned.get(run.anthillRunId);
    if (!spawns) {
      spawns = new Map();
      this.spawned.set(run.anthillRunId, spawns);
    }
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
      scan(
        chunk.lines,
        state,
        now,
        { runId: run.anthillRunId, nonce: run.correlationNonce, gates, reported: context?.reported },
        events,
        spawns,
      );
    }

    // A subagent's work, tied to the call that started it — known by now even
    // when the subagent's file was read before the session's in this poll.
    for (const event of events) {
      if (!event.parentToolUseId?.startsWith(PENDING_SPAWN)) continue;
      const call = spawns.get(event.parentToolUseId.slice(PENDING_SPAWN.length));
      if (call) event.parentToolUseId = call;
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
        evidence.push({ kind: "activity", sessionId, channel: CHANNEL, at: state.lastActivityAt });
      }

      // A subagent's file carries the session's id, so a binding follows it
      // too; its ending and its errors are that subagent's, already in the
      // feed as its own. Read as the session's, every subagent's task_complete
      // said "Session finished" while the parent worked on (ANT-235).
      if (state.delegate) {
        state.reportedActivityAt = state.lastActivityAt;
        continue;
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

      // Still the last thing the session wrote, so a session somebody carried
      // on with is not held down by the Stop they pressed earlier — the same
      // rule as Claude Code's (ANT-122).
      if (state.interruptedAt && state.interruptedAt === state.lastActivityAt) {
        evidence.push({
          kind: "interrupted",
          sessionId,
          channel: CHANNEL,
          at: state.interruptedAt,
          detail: "You stopped this session. Anthill is no longer reading it; nothing was sent to the session.",
        });
      }

      // Waiting for an answer at a gate: still the session, still open. Said on
      // every look while it holds, and only for as long as a copied prompt is
      // given to be claimed — past that, silence is silence again (ANT-210).
      if (
        state.awaitingAt &&
        Date.parse(now) - Date.parse(state.awaitingAt) < TIMING.pendingTtlMs
      ) {
        evidence.push({
          kind: "awaiting",
          sessionId,
          at: now,
          since: state.awaitingAt,
          detail: "Codex asked at the approval and is waiting for your answer.",
        });
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

/** A call's JSON arguments or output, when that is what it carries. */
function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value) && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    state.lastStep = { blockId, from, at: base.at };
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
 * The step the session was on at a moment: the last one announced, in its own
 * record or through the CLI, at or before then.
 *
 * `anthill step` prints only "Step … reported.", which names no run, so a
 * session reporting through the CLI never announces a step in this record —
 * and its turn ending at an Approval Gate read as the session finishing
 * (ANT-240).
 */
function stepAsOf(state: FileState, reported: ReportedProgress | undefined, at: string): string | undefined {
  const moment = Date.parse(at);
  let step = state.lastStep?.blockId;
  let when = state.lastStep ? Date.parse(state.lastStep.at) : Number.NEGATIVE_INFINITY;
  for (const report of reported?.steps ?? []) {
    const told = Date.parse(report.at);
    if (told <= moment && told >= when) {
      step = report.blockId;
      when = told;
    }
  }
  return step;
}

/** Whether `anthill done` had been reported by then. */
function reportedDoneBy(reported: ReportedProgress | undefined, at: string): boolean {
  return reported?.doneAt !== undefined && Date.parse(reported.doneAt) <= Date.parse(at);
}

/**
 * Read only what matters: the session id, the user's message, any step the
 * agent announced, tool calls, the turn-completion record, and errors.
 */
function scan(
  lines: string[],
  state: FileState,
  now: string,
  /**
   * And the run's Approval Gates, by step id (ANT-210), and what the harness
   * reported through the CLI, which this record never shows (ANT-240).
   */
  marker: { runId: string; nonce: string; gates?: ReadonlySet<string>; reported?: ReportedProgress },
  events: ObservationEventDraft[],
  spawns: Map<string, string> = new Map(),
): void {
  for (const line of lines) {
    // Nothing a sub-thread writes is the session's own doing (ANT-129).
    if (state.subthread) return;
    // Counted from 0, as Codex counts `ordinal`; a record without one is
    // placed by how many came before it.
    const read = state.linesRead ?? 0;
    state.linesRead = read + 1;
    if (!line.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ordinal = typeof row.ordinal === "number" ? row.ordinal : read;
    // A subagent's copy of the parent's history is the parent's, already read
    // from the parent's own file (ANT-211).
    if (state.delegate && state.ownFrom !== undefined && ordinal < state.ownFrom) continue;

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
      // A second session record in a subagent's file is the parent's, at the
      // head of the history copied in from it (ANT-211).
      if (state.delegate) {
        if (state.ownFrom === undefined) state.inheriting = true;
        continue;
      }
      const session = str(payload.session_id);
      const thread = str(payload.id);
      /*
        A subagent the session spawned (ANT-171). The rule below was written
        for the reviewer and caught these too, so everything a subagent said
        and ran was dropped and the Agents filter was always empty. The
        records tell them apart: a subagent is `thread_source: "subagent"`
        with a `thread_spawn`, the reviewer is `guardian_review`.
      */
      const source = isRecord(payload.source) && isRecord(payload.source.subagent) ? payload.source.subagent : undefined;
      const spawn = source && isRecord(source.thread_spawn) ? source.thread_spawn : undefined;
      if (str(payload.thread_source) === "subagent" || spawn) {
        const path = str(payload.agent_path) ?? str(spawn?.agent_path) ?? thread ?? "subagent";
        const name = path.split("/").filter(Boolean).pop() ?? path;
        state.delegate = { path, name };
        const from = payload.subagent_history_start_ordinal;
        if (typeof from === "number" && Number.isInteger(from) && from > ordinal) state.ownFrom = from;
        const id = session ?? str(spawn?.parent_thread_id);
        if (id) state.sessionId = id;
        if (stamped) state.lastActivityAt = stamped;
        continue;
      }
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

    // Without an ordinal, the copy ends where the subagent's own settings are
    // applied, just after the role it is given.
    if (state.inheriting) {
      const role = payload.type === "message" && payload.role === "developer" && messageText(payload).trimStart().startsWith("<multi_agent_role>");
      if (payload.type !== "thread_settings_applied" && !role) continue;
      state.inheriting = false;
    }

    if (stamped) state.lastActivityAt = stamped;
    const base = {
      at,
      cli: "codex" as const,
      source: "rollout" as const,
      channel: CHANNEL,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      // A subagent's work carries the call that started it, and its name.
      ...(state.delegate
        ? {
            parentToolUseId: spawns.get(state.delegate.path) ?? `${PENDING_SPAWN}${state.delegate.path}`,
            author: { kind: "subagent" as const, name: state.delegate.name },
          }
        : {}),
    };

    if (row.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") {
        // A subagent's task is the session's message to it, not the author's.
        if (state.delegate) continue;
        if (textCarriesMarker(messageText(payload), marker)) {
          state.matched = true;
          events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
        }
        continue;
      }
      if (payload.role === "assistant") {
        const text = messageText(payload);
        // A subagent's word is not where the session is, nor its ending.
        if (!state.delegate) {
          announceSteps(text, "reply", state, marker, base, events);
          announceDone(text, state, marker, base, events);
        }
        // And one cut-down line of what it said. Codex writes its reasoning to
        // a different record type entirely, which this branch never sees.
        const said = messageExcerpt(text, marker);
        if (said) {
          // The session's own, or — in a subagent's thread — that agent's.
          const tag = parseStepTag(text);
          events.push({
            ...base,
            kind: "message",
            title: "Message",
            detail: said,
            author: base.author ?? { kind: "main" },
            ...(tag ? { stepTag: tag } : {}),
          });
        }
      }
      continue;
    }

    if (row.type === "response_item") {
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = str(payload.name) ?? "a tool";
        const call = str(payload.call_id);
        // Starting a subagent: a delegation, sent off on its own — the call
        // returns at once and the subagent's own turn ending is its end.
        if (name === "spawn_agent" && call) {
          (state.spawnCalls ??= new Set()).add(call);
          const args = parseArguments(payload.arguments ?? payload.input);
          const agent = str(args?.task_name) ?? str(args?.agent_type);
          events.push({
            ...base,
            kind: "subagent.start",
            title: "Delegated to a subagent",
            toolName: name,
            toolUseId: call,
            background: true,
            ...(agent ? { agentName: agent } : {}),
          });
          continue;
        }
        events.push({
          ...base,
          kind: "tool.start",
          title: name,
          toolName: name,
          ...(call ? { toolUseId: call } : {}),
        });
      }
      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const call = str(payload.call_id);
        const spawnReceipt = call !== undefined && state.spawnCalls?.has(call);
        if (spawnReceipt && call) {
          // The path the subagent will name itself by.
          const receipt = parseArguments(payload.output);
          const path = str(receipt?.task_name);
          if (path) spawns.set(path, call);
        }
        events.push({
          ...base,
          kind: "tool.end",
          title: "Tool finished",
          ...(call ? { toolUseId: call } : {}),
          ...(spawnReceipt ? { background: true } : {}),
        });
        // Asked to "print" a marker, an agent whose only way to print is a
        // shell prints it with one: Codex Desktop writes `printf 'ANTHILL-STEP
        // …'`, and the line exists only in the command's output (ANT-147).
        // Only the output is read — the command itself merely names the line,
        // and a command that fails to print it has not announced anything.
        // Not a command that printed the prompt itself, though: that carries
        // every step's line at once, and would announce them all (ANT-162).
        const output = outputText(payload.output);
        // A subagent's commands are not where the session is, nor its ending.
        if (!state.delegate && !textCarriesMarker(output, marker)) {
          const call = str(payload.call_id);
          announceSteps(output, "command", state, marker, call ? { ...base, printedBy: call } : base, events);
          announceDone(output, state, marker, base, events);
        }
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
      if (payload.type === "task_started" && !state.delegate) state.awaitingAt = undefined;
      // A turn that ended on an Approval Gate, with no done line: the gate's
      // question put to a person, not the session finishing (ANT-210).
      // The step and the done line may each have been said in this record or
      // reported through the CLI, which a bound run always does (ANT-240).
      const endedAt = payload.type === "task_complete" && !state.delegate ? stepAsOf(state, marker.reported, at) : undefined;
      if (
        endedAt &&
        marker.gates?.has(endedAt) &&
        !state.doneReported &&
        !reportedDoneBy(marker.reported, at)
      ) {
        state.awaitingAt = at;
        events.push({
          ...base,
          kind: "notification",
          title: "Waiting for your answer",
          detail: "Codex asked at the approval and ended its turn. Nobody has answered yet.",
        });
      } else if (payload.type === "task_complete") {
        state.completedAt = at;
        state.reportedComplete = false;
        // Codex's own word that the task is over — typed, so the fold does not
        // have to recognise it by where it came from (ANT-158).
        events.push({ ...base, kind: "turn.end", title: "Codex finished the turn", completion: "task_complete" });
      }
      // Stopped by the person. In the session's own file that is the session
      // stopping; in a subagent's, only that subagent (ANT-208).
      if (payload.type === "turn_aborted") {
        if (!state.delegate) state.interruptedAt = at;
        events.push({ ...base, kind: "notification", title: "Stopped by hand" });
      }
      if (payload.type === "error" || payload.type === "stream_error") {
        const message = str(payload.message) ?? "Codex recorded an error.";
        state.failure = message;
        events.push({ ...base, kind: "error", title: "Codex recorded an error", detail: message });
      }
    }
  }
}
