/**
 * Recognising, and then following, a Claude Code session the user started.
 *
 * Claude Code writes every session to `~/.claude/projects/<slug>/<id>.jsonl` as
 * it goes, and the first thing it writes for a turn is the user's own message —
 * which, for a pasted Anthill prompt, contains the run marker. So detection
 * needs no cooperation from the agent and no hook installed in the user's
 * config: the evidence is already there, in a record the tool owns.
 *
 * The same pass produces the activity the Live Session page shows. What is read
 * is deliberately narrow, and the narrowness is the point:
 *
 * - user messages: only whether they carry the run marker;
 * - assistant messages: `stop_reason`, any Anthill step marker the agent
 *   printed, and one cut-down line of what it said to the person watching.
 *   `thinking` and `redacted_thinking` blocks are skipped by name before
 *   anything is read out of them, so the model's own working never reaches
 *   this file, let alone the page;
 * - tool blocks: the tool's name, its id, and the one field that names what it
 *   is acting on. Never its output.
 *
 * Limits, stated rather than papered over: a transcript records no
 * session-level failure and no "waiting for you", so a Claude Code session that
 * stops reads as quiet, and permission prompts are only visible through hooks.
 */

import { readdir, readFile, stat } from "node:fs/promises";
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
  type ObservationContext,
  type ObservationEventDraft,
  type ObserverCapabilities,
  type PollResult,
} from "./types.js";
import { newCursor, readNewLines, type TailCursor } from "./tail.js";

/**
 * How quiet a matched session must be before its last turn counts as finished.
 *
 * This was fifteen seconds, which is the length of one tool call. An agent
 * working through a workflow ends a turn, thinks, and starts another — so the old
 * window declared the session finished during its first step and stopped
 * watching, seventeen seconds before the agent printed the marker that would
 * have moved the diagram.
 *
 * A turn ending is not a session ending, and a transcript cannot tell the two
 * apart. The window is now the same silence that would otherwise be called
 * "observation lost": long enough that the difference between the two is which
 * way the last turn ended, not how fast the agent types.
 */
const SETTLE_MS = 5 * 60_000;

/** Stop reasons that mean the agent finished answering rather than paused. */
const TERMINAL_STOP = new Set(["end_turn", "stop_sequence"]);

/**
 * Tools that hand work somewhere this transcript will not describe.
 *
 * `Task` and `Agent` come back: their result lands in this same file, so the
 * wait has a visible end. `SendMessage` addresses a background agent and
 * returns at once, while the work goes on somewhere Claude Code does not write
 * here at all — there is no second transcript and no `isSidechain` record to
 * read. After one of those, silence in this file stops being evidence about
 * the session, and inferring an ending from it is a guess dressed as a fact.
 *
 * Which of the two a call is cannot be read off the name alone. `Task` and
 * `Agent` also take `run_in_background`, and with it they behave exactly like
 * `SendMessage`: in the session ANT-70 was reported from, two foreground
 * `Agent` calls returned after 428 and 773 seconds while all three background
 * ones returned in two — a receipt saying the agent had started, not the work.
 * So the property is `run_in_background`, and the name only says whether a
 * result is the work or a receipt for it.
 */
const AWAITED_DELEGATION = new Set(["Task", "Agent"]);
const BACKGROUND_DELEGATION = new Set(["SendMessage"]);

/** Whether this call hands work off somewhere this transcript will not follow. */
function goesToBackground(name: string, input: Record<string, unknown>): boolean {
  if (BACKGROUND_DELEGATION.has(name)) return true;
  return AWAITED_DELEGATION.has(name) && input.run_in_background === true;
}

const CHANNEL = "claude-code:transcript";

/** A transcript worth reading, and whose turns it holds. */
type Candidate = { path: string; delegate: boolean; name?: string };

/**
 * What a delegate was for, in the tool's own words.
 *
 * Beside each delegate's transcript Claude Code writes a `.meta.json` naming
 * the agent type it was spawned as and the description the dispatching call
 * gave it. The description is the better label: every delegate in the session
 * ANT-54 was verified on was spawned as `general-purpose`, which tells a
 * reader nothing, while "Survey session observation" and "Survey workflow
 * compilation" told them apart at a glance. The type is kept as the fallback
 * for a delegate spawned without one.
 *
 * A file that is missing or unreadable names nothing, and the delegate is
 * shown as what it is — a subagent — rather than as a guess.
 */
async function delegateName(transcript: string): Promise<string | undefined> {
  const meta = transcript.replace(/\.jsonl$/, ".meta.json");
  const text = await readFile(meta, "utf8").catch(() => undefined);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    return str(parsed.description) ?? str(parsed.agentType);
  } catch {
    return undefined;
  }
}

type FileState = {
  /** How far into the transcript this run has read. Bytes, always. */
  cursor: TailCursor;
  sessionId?: string;
  matched: boolean;
  /**
   * Whether this file is a delegate's own transcript rather than the session's.
   *
   * Claude Code writes each subagent to
   * `<project>/<sessionId>/subagents/agent-*.jsonl`, carrying the parent's
   * `sessionId` and marking every row `isSidechain`. Those files hold what the
   * delegate actually said — the thing the Live Session page could never show
   * (ANT-54) — and they are the session's work as much as the main file is.
   *
   * What they are not is a second opinion about the session's *state*. A
   * delegate ending its turn is not the session ending, so nothing here is
   * allowed to settle the run; these files bring events and signs of life and
   * nothing else.
   */
  delegate?: boolean;
  /** What the delegate was for, from its own `.meta.json`. See `delegateName`. */
  delegateName?: string;
  /** Delegations whose result has not come back yet, by tool-use id. */
  awaiting: Set<string>;
  /**
   * Whether this session has handed work to a background agent.
   *
   * Sticky for the life of the session, because nothing ever tells Anthill the
   * background work is over. Once it is true, silence here means "Anthill
   * cannot see what is happening", which is not the same as "nothing is".
   */
  dispatched: boolean;
  lastStopReason?: string;
  lastActivityAt?: string;
  /**
   * Assistant message ids whose usage has been taken.
   *
   * A message streams as several transcript records and each repeats the same
   * usage figures, so summing per record would double-count. One message, one
   * usage event — keyed on the id the vendor itself uses.
   */
  usageSeen: Set<string>;
  /** The activity timestamp already reported, so it is not reported twice. */
  reportedActivityAt?: string;
  settled: boolean;
};

export class ClaudeCodeObserver implements LiveSessionObserver {
  readonly cli = "claude-code" as const;

  private readonly root: string;
  private readonly seen = new Map<string, Map<string, FileState>>();

  /** The root is injectable so the scanner can be tested against fixtures. */
  constructor(root: string = join(homedir(), ".claude", "projects")) {
    this.root = root;
  }

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
        ? "Anthill reads the session transcripts Claude Code writes for itself."
        : "Claude Code has written no local sessions on this machine, so there is nothing to read.",
      reportsCompletion: true,
      reportsFailure: false,
    };
  }

  forget(runId: string): void {
    this.seen.delete(runId);
  }

  async poll(run: PendingRun, now: string, context?: ObservationContext): Promise<PollResult> {
    const files = await this.candidates(run);
    if (files === undefined) {
      return {
        events: [],
        evidence: [
          {
            kind: "unobservable",
            channel: CHANNEL,
            at: now,
            detail: "Claude Code has no local session records on this machine.",
          },
        ],
      };
    }

    const states = this.statesFor(run.anthillRunId);
    const evidence: Evidence[] = [];
    const events: ObservationEventDraft[] = [];
    const grew = new Set<string>();

    for (const { path, delegate, name: label } of files) {
      const state =
        states.get(path) ??
        {
          cursor: newCursor(),
          // A delegate's transcript carries no run marker — the marker is in
          // the prompt somebody pasted into the session, and a subagent was
          // never handed it. Where the file *is* answers the question the
          // marker answers for the main transcript, and answers it better: a
          // file under this session's own `subagents` folder is this
          // session's, as a matter of the tool's own filing.
          matched: delegate,
          settled: false,
          awaiting: new Set<string>(),
          dispatched: false,
          usageSeen: new Set<string>(),
          ...(delegate ? { delegate: true } : {}),
          ...(label ? { delegateName: label } : {}),
        };
      states.set(path, state);

      const chunk = await readNewLines(path, state.cursor);
      if (!chunk.grew) continue;
      grew.add(path);
      scan(chunk.lines, state, now, { runId: run.anthillRunId, nonce: run.correlationNonce }, events);
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
          // The marker is in a record Claude Code wrote itself, and carries the
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
        // Only new work is activity. A transcript can grow by records this
        // observer deliberately skips — the model's own reasoning, for one —
        // and reporting that as activity would keep a finished run looking
        // alive.
        state.reportedActivityAt = state.lastActivityAt;
        evidence.push({ kind: "activity", sessionId, at: state.lastActivityAt });
      }

      /*
        Silence measured across every channel, not just this file.

        A session's last word is the latest thing *anything* recorded about it,
        and since ANT-64 the hook log is usually the busier of the two: in the
        session ANT-70 was reported from, 212 hook events for this session
        landed during the thirty-seven minutes this transcript said nothing.
        Reading only this file, the observer concluded the session had finished
        while another channel was watching it work.

        `run.lastObservedAt` is one poll behind, which against a five-minute
        threshold does not matter, and it never runs ahead of the truth: it
        moves only when a channel actually reported something.
      */
      const lastWord = [state.lastActivityAt, run.lastObservedAt]
        .filter((value): value is string => Boolean(value))
        .reduce<string | undefined>(
          (latest, value) => (latest && latest >= value ? latest : value),
          undefined,
        );
      const quietFor = lastWord ? Date.parse(now) - Date.parse(lastWord) : 0;
      // ANT-18. A terminal stop reason plus a long silence used to be read as
      // an ending. Delegating a stage produces exactly that shape — the agent
      // dispatches, says so, ends its turn, and then waits for as long as the
      // work takes — so a workflow that delegates was announced as finished
      // while it was mid-stage. Anthill cannot see the delegate's work, so the
      // only honest thing it can say about that silence is that it cannot see
      // anything, which is what the quiet path already says and what it says
      // recoverably.
      /*
        Work handed somewhere this file will not describe.

        `dispatched` is sticky, because nothing in *this* channel ever says the
        background work is over. That was the only protection available when it
        was written, and as the sole gate it is too strong: one backgrounded
        delegation and the session could never be reported as finished again,
        so a workflow that demonstrably completed sat at "Observation lost"
        with its last step unknown and the diagram never went green (ANT-75).

        It stands down when the hook log is carrying news about this run,
        because then the question is answered by evidence instead: a delegate
        that is genuinely working writes hooks under this same session — 2830
        of them in the reported run, 212 during one thirty-six minute stretch
        where this file said nothing — and the session's own
        `background_tasks` list says outright what it is still waiting on.
        Silence across every channel then means what it says.

        With no hooks on this run the transcript is alone again, nothing can
        retract the handover, and the sticky flag remains the honest answer.
      */
      const handedOff =
        state.awaiting.size > 0 || (state.dispatched && !context?.hooksWatching);
      if (
        !state.settled &&
        // A delegate ending its turn is not the session ending. These files
        // are read for what was said and done in them, never for a verdict on
        // the run — the session's own transcript is the only thing entitled
        // to settle it.
        !state.delegate &&
        !handedOff &&
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

    // Events are only worth keeping once the session they came from is the one
    // this run is about; before that they belong to somebody else's work.
    const owned =
      new Set(following.map(([, state]) => state.sessionId as string)).size === 1
        ? (following[0][1].sessionId as string)
        : run.detectedSessionId;
    return {
      evidence,
      events: owned ? events.filter((event) => event.sessionId === owned && isThisRun(event, run)) : [],
    };
  }

  private async candidates(run: PendingRun): Promise<Candidate[] | undefined> {
    const projects = await readdir(this.root).catch(() => undefined);
    if (projects === undefined) return undefined;

    // A minute of slack, because a session can be started a moment before the
    // copy finishes and clocks are not exact.
    const floor = Date.parse(run.createdAt) - 60_000;
    const found: Candidate[] = [];

    for (const project of projects) {
      const dir = join(this.root, project);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs >= floor) found.push({ path, delegate: false });
      }

      /*
        The delegates of the session being followed.

        Only once there is a session to follow, and only that session's own
        folder: before a match there is nothing to look under, and walking
        every session's delegates would be a directory tree per poll for
        files belonging to somebody else's run.
      */
      if (!run.detectedSessionId) continue;
      const nest = join(dir, run.detectedSessionId, "subagents");
      const delegates = await readdir(nest).catch(() => [] as string[]);
      for (const name of delegates) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(nest, name);
        const info = await stat(path).catch(() => undefined);
        if (!info || info.mtimeMs < floor) continue;
        const label = await delegateName(path);
        found.push({ path, delegate: true, ...(label ? { name: label } : {}) });
      }
    }
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

/**
 * Whether a matched candidate is still in the running to be *the* session.
 *
 * Used only while more than one candidate carries the marker. A session that
 * inferred its own ending, or that has been quiet longer than Anthill would
 * claim any session for, has left the contest — its transcript staying on disk
 * is a fact about files, not about sessions.
 */
function contends(state: FileState, now: string): boolean {
  if (state.settled) return false;
  if (!state.lastActivityAt) return true;
  return Date.parse(now) - Date.parse(state.lastActivityAt) <= TIMING.activityTtlMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Tools whose input names the thing being acted on, and which field says so. */
function toolTarget(name: string, input: Record<string, unknown>): string | undefined {
  if (name === "Bash") return str(input.description) ?? str(input.command);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return path.split("/").slice(-2).join("/");
  return str(input.pattern) ?? str(input.query) ?? str(input.description);
}

/**
 * Read only what is needed, from one chunk of newly written transcript.
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

    if (typeof row.sessionId === "string") state.sessionId = row.sessionId;
    const at = str(row.timestamp) ?? now;
    state.lastActivityAt = at;

    const base = {
      at,
      cli: "claude-code" as const,
      source: "transcript" as const,
      channel: CHANNEL,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };

    if (row.type === "user") {
      const message = isRecord(row.message) ? row.message : undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];

      const carries = (value: unknown) =>
        typeof value === "string" && textCarriesMarker(value, marker);

      if (carries(message?.content)) {
        state.matched = true;
        events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
      } else {
        for (const block of blocks) {
          if (isRecord(block) && carries(block.text)) {
            state.matched = true;
            events.push({ ...base, kind: "prompt.submit", title: "The workflow was pasted in" });
          }
          // A tool result closes the call that opened it. Only the outcome is
          // read; the result body stays where Claude Code wrote it.
          if (isRecord(block) && block.type === "tool_result") {
            const id = str(block.tool_use_id);
            if (id) state.awaiting.delete(id);
            events.push({
              ...base,
              kind: "tool.end",
              title: "Tool finished",
              ok: block.is_error !== true,
              ...(id ? { toolUseId: id } : {}),
            });
          }
        }
      }
      continue;
    }

    if (row.type === "assistant") {
      const message = isRecord(row.message) ? row.message : undefined;
      /*
        Authorship, from the record's own field.

        Claude Code marks a turn taken by a subagent with `isSidechain`. Every
        transcript on the machine this was written against carries the field
        and has it false throughout — which agrees with what ANT-18 found: the
        delegate's work is not written into the session's own transcript at
        all. So in practice this says "main", and the branch for a sidechain
        exists because the field does, not because it has been seen true.

        A sidechain turn is named only if the record names it. Reaching for
        the `subagent_type` of a nearby Task call would be a guess dressed as
        evidence. The record does name it, in the `.meta.json` Claude Code
        writes beside each delegate's transcript — read once when the file is
        found and carried on its state — and that is what a delegate's turns
        are signed with (ANT-54).
      */
      const named = str(row.agentName) ?? state.delegateName;
      const author: { kind: "main" } | { kind: "subagent"; name?: string } =
        row.isSidechain === true
          ? { kind: "subagent", ...(named ? { name: named } : {}) }
          : { kind: "main" };
      state.lastStopReason = str(message?.stop_reason);
      state.settled = false;

      // Usage rides every streamed record of a message, repeated in full, so
      // it is taken once per message id. The id doubles as the journal's
      // dedup key (in `toolUseId`), so a re-read cannot count it twice either.
      const usage = isRecord(message?.usage) ? message.usage : undefined;
      const messageId = str(message?.id);
      if (usage && messageId && !state.usageSeen.has(messageId)) {
        state.usageSeen.add(messageId);
        const num = (value: unknown) => (typeof value === "number" ? value : 0);
        events.push({
          ...base,
          kind: "usage",
          title: "Token usage recorded",
          toolUseId: messageId,
          tokens: {
            in:
              num(usage.input_tokens) +
              num(usage.cache_creation_input_tokens) +
              num(usage.cache_read_input_tokens),
            out: num(usage.output_tokens),
          },
        });
      }

      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;

        // The model's own working. It stops here, and no branch below can see it.
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;

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
            events.push({ ...base, kind: "message", title: "Message", detail: said, author });
          }
          continue;
        }

        if (block.type === "tool_use") {
          const name = str(block.name) ?? "a tool";
          const input = isRecord(block.input) ? block.input : {};
          const id = str(block.id);
          // Claude Code's delegation tool has been called both `Task` and
          // `Agent` across versions; both carry `subagent_type`, which is the
          // one field that can tie work to a workflow's agent.
          const isDelegation = AWAITED_DELEGATION.has(name);
          const background = goesToBackground(name, input);
          // A delegation that comes back is a wait with a visible end; one that
          // does not is a hole in what this transcript can ever say. Waiting on
          // a backgrounded one would be worse than not waiting at all: its
          // receipt arrives within seconds and would clear the wait while the
          // work is still ahead.
          if (isDelegation && id && !background) state.awaiting.add(id);
          if (background) state.dispatched = true;
          events.push({
            ...base,
            kind: isDelegation ? "subagent.start" : "tool.start",
            title: isDelegation ? "Delegated to a subagent" : name,
            toolName: name,
            ...(id ? { toolUseId: id } : {}),
            ...(isDelegation && str(input.subagent_type)
              ? { agentName: str(input.subagent_type) as string }
              : {}),
            ...(toolTarget(name, input) ? { detail: toolTarget(name, input) as string } : {}),
            ...(str(row.parent_tool_use_id)
              ? { parentToolUseId: str(row.parent_tool_use_id) as string }
              : {}),
          });
        }
      }

      /*
        The turn ending, said out loud.

        This observer already had the record — it reads `stop_reason` and uses
        it to time a settle five minutes later — and threw the moment itself
        away. Only the hook log wrote `turn.end`, so a session observed through
        the transcript alone could never show a step as waiting on a person
        (ANT-47): the diagram said "Working" until the settle, and then said
        "Done", both at a step where the agent was waiting to be answered.

        A terminal stop reason is written once per yield — an assistant record
        that is about to call a tool carries `tool_use` instead — so this is
        one event per time the agent actually stopped, not one per record. The
        message id carries the dedup where the record has one; where it does
        not, the timestamp and title in the fingerprint do, and a turn cannot
        end twice in the same millisecond.
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
