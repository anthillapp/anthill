/**
 * Reading the lifecycle hooks the user chose to install.
 *
 * Hooks tell Anthill two things a transcript tells it less well: that a session
 * is *waiting for a person*, and how long a tool call actually took. Both
 * matter on the Live Session page — "waiting on you" is a state a person needs
 * to see, and inferring it from silence would be a guess dressed as a fact.
 *
 * Only the first of those is now shared. A transcript cannot time a tool call,
 * but it does record that a turn ended, and since ANT-47 it says so: the
 * Notification hook remains the CLI stating outright that it wants something
 * from a person, while a turn ending is the weaker record that the agent
 * handed control back — enough to stop the diagram claiming it is working.
 *
 * This reader is passive in the same way everything else here is. It does not
 * install anything (that is `setup.ts`, and only on an explicit user action)
 * and it does not run when a session runs — the hook handler writes a line to
 * `~/.anthill/live-hooks/events.jsonl` and exits, and this reads that file
 * afterwards. If the user never installed hooks the file never exists, and the
 * page simply has less to show and says so.
 *
 * The log is machine-wide, so lines are kept only once the run has a session id
 * to match them against. Before that, another session's hooks are somebody
 * else's business.
 *
 * Every line kept is also evidence that the session is alive, and is reported
 * as such. It was not, once: this reader produced page events and nothing
 * else, so the clock that decides whether a session has gone quiet heard only
 * the transcript. A session doing its work through subagents writes the
 * transcript rarely and the hook log constantly — 638 of one run's 659 records
 * came through here — and the run was declared lost, twice, in the middle of
 * that work (ANT-64). What is worth showing on the page is worth counting as
 * a sign of life.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { TIMING, parseDoneMarker, parseStepMarkers, type Evidence, type MarkerCli, type PendingRun } from "@anthill/live";

import type { ObservationEventDraft, PollResult } from "./types.js";
import { newCursor, readRotatingLines, type TailCursor } from "./tail.js";
import { minimalHookPayload } from "../hook-payload.js";

export const HOOK_LOG = join(homedir(), ".anthill", "live-hooks", "events.jsonl");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** How each hook event reads on the page. */
const KIND: Record<string, ObservationEventDraft["kind"]> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  PreToolUse: "tool.start",
  PostToolUse: "tool.end",
  SubagentStop: "subagent.end",
  Notification: "notification",
  Stop: "turn.end",
};

const TITLE: Record<string, string> = {
  SessionStart: "Session started",
  SessionEnd: "Session ended",
  UserPromptSubmit: "A prompt was submitted",
  SubagentStop: "A subagent finished",
  Notification: "The session is waiting for you",
  Stop: "The agent finished its turn",
};

/** The field of a tool's input that names what it is acting on. */
function toolTarget(name: string | undefined, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (name === "Bash") return str(input.description) ?? str(input.command);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return path.split("/").slice(-2).join("/");
  return str(input.pattern) ?? str(input.query) ?? str(input.description);
}

/** A tool call seen starting, still waiting to be seen finishing. */
type OpenCall = { at: string; toolName?: string };

/**
 * A delegation the session itself reports as still running.
 *
 * Claude Code puts a `background_tasks` list on its `Stop` and
 * `SubagentStop` records: the work it dispatched and has not finished. It is
 * the session's own account of what is outstanding, which is a far better
 * answer than inferring one from silence — and it is maintained rather than
 * appended to. Measured over the session ANT-75 was reported from: seventeen
 * tasks, sixteen of which left the list when they finished.
 *
 * `since` is when *Anthill* first saw it listed, not when the session started
 * it, because the expiry below is about how long a record has gone
 * uncorroborated rather than how long work may take.
 */
type BackgroundTask = { since: string; description?: string };

/**
 * How long an unfinished tool call is still taken as a sign of life.
 *
 * Nothing ever retracts a `PreToolUse`. A session killed mid-tool, or a hook
 * that failed to write its `PostToolUse`, leaves one open forever — this log
 * has one from a permission prompt that was never answered, open for over an
 * hour. So the claim has to expire, and it expires on the same clock that
 * decides a matched session has stopped being worth reading: long enough for
 * any build or test suite somebody would sit through, short enough that a
 * stale record cannot keep a dead session looking alive all day.
 */
const IN_FLIGHT_TTL_MS = TIMING.silenceTtlMs;

export class HookLogObserver {
  private readonly path: string;
  /** Bytes already read, per run, so a growing log is never re-parsed whole. */
  private readonly cursors = new Map<string, TailCursor>();
  /**
   * The latest moment already reported as activity, per run.
   *
   * Lines can land in the log out of order — a subagent's hooks and the main
   * session's interleave — and a late line about an earlier moment is not
   * news about now.
   */
  private readonly reportedAt = new Map<string, string>();
  /**
   * Tool calls this session started that have not reported back, per run.
   *
   * A `PreToolUse` with no `PostToolUse` is the strongest thing either channel
   * ever says: work is happening *now*. Nothing more can arrive until the tool
   * returns, so the silence after it is the tool running, not the session
   * stopping — and the longer the tool takes, the more certain the old clock
   * became that the session was gone (ANT-71).
   */
  private readonly open = new Map<string, Map<string, OpenCall>>();
  /**
   * When each run's session was stopped by hand, once anything has said so.
   *
   * A watermark rather than a one-off clearing, because this log is re-read
   * from disk: anything it opened at or before that moment is not coming back,
   * however many times the line is read. Never cleared — a session somebody
   * carries on with writes newer records, and those are above the mark.
   */
  private readonly stoppedAt = new Map<string, string>();
  /**
   * Delegations the session last said were still running, per run.
   *
   * Kept apart from `open` because the two are different claims: an open tool
   * call is work this session is doing right now, a background task is work it
   * handed to somebody else and has not heard back about.
   */
  private readonly background = new Map<string, Map<string, BackgroundTask>>();
  /**
   * Runs this log has actually said something about.
   *
   * Not "are hooks installed" — that a log file exists somewhere says nothing
   * about whether *this* session writes to it. The question other readers need
   * answered is narrower and is the one that matters: is this run being
   * watched by a second channel, or is the transcript on its own?
   */
  private readonly covered = new Set<string>();

  constructor(path: string = HOOK_LOG) {
    this.path = path;
  }

  forget(runId: string): void {
    this.cursors.delete(runId);
    this.reportedAt.delete(runId);
    this.open.delete(runId);
    this.background.delete(runId);
    this.covered.delete(runId);
  }

  /** Whether hooks are installed and have ever recorded anything. */
  async available(): Promise<boolean> {
    return stat(this.path).then(
      (info) => info.isFile(),
      () => false,
    );
  }

  /**
   * Read whatever the log has gained.
   *
   * Only lines whose session id matches this run are kept, which is why nothing
   * is returned until the run has been matched to a session by another channel.
   * Whatever is kept is reported as activity too, at the moment of the newest
   * line — one piece of evidence per poll, however many lines arrived.
   */
  async poll(run: PendingRun, now: string): Promise<PollResult> {
    if (!run.detectedSessionId) return { evidence: [], events: [] };

    let cursor = this.cursors.get(run.anthillRunId);
    if (!cursor) {
      cursor = newCursor();
      this.cursors.set(run.anthillRunId, cursor);
    }

    const sessionId = run.detectedSessionId;
    let inFlight = this.open.get(run.anthillRunId);
    if (!inFlight) {
      inFlight = new Map<string, OpenCall>();
      this.open.set(run.anthillRunId, inFlight);
    }
    let delegated = this.background.get(run.anthillRunId);
    if (!delegated) {
      delegated = new Map<string, BackgroundTask>();
      this.background.set(run.anthillRunId, delegated);
    }

    const stoppedAt = this.stoppedAt.get(run.anthillRunId);
    const chunk = await readRotatingLines(this.path, cursor);
    // A log that has not grown can still be saying something: a tool that
    // opened before this poll and has not closed is work in flight now, and so
    // is a delegation the session last reported as still running.
    if (!chunk.grew) return { evidence: this.stillWorking(inFlight, delegated, sessionId, now), events: [] };

    const events: ObservationEventDraft[] = [];
    /** The session saying it is over, if this read contained that. */
    let ended: { at: string; cli: MarkerCli; detail: string } | undefined;
    for (const line of chunk.lines) {
      if (!line.startsWith("{")) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const data = isRecord(row.data) ? minimalHookPayload(row.data) : undefined;
      if (!data) continue;
      if (str(data.session_id) !== run.detectedSessionId) continue;
      this.covered.add(run.anthillRunId);

      const name = str(data.hook_event_name) ?? str(row.eventType) ?? "";

      /*
        The session's own list of what it is still waiting on.

        Read before the event kind is checked, because it rides on records
        this reader otherwise has no use for, and it is a *replacement* rather
        than an addition: a task that has finished is simply no longer in the
        list, which is what makes the list worth trusting.
      */
      if (Array.isArray(data.background_tasks)) {
        const listed = new Map<string, BackgroundTask>();
        for (const task of data.background_tasks) {
          if (!isRecord(task)) continue;
          const id = str(task.id);
          if (!id || str(task.status) !== "running") continue;
          const description = str(task.description);
          listed.set(id, {
            // Kept from the first sighting, so the expiry measures how long a
            // record has gone uncorroborated rather than restarting each poll.
            since: delegated.get(id)?.since ?? (str(row.recordedAt) ?? now),
            ...(description ? { description } : {}),
          });
        }
        delegated.clear();
        if (!(stoppedAt && (str(row.recordedAt) ?? now) <= stoppedAt)) {
          for (const [id, task] of listed) delegated.set(id, task);
        }
      }

      const kind = KIND[name];
      if (!kind) continue;

      const cli = (str(row.harness) as MarkerCli | undefined) ?? run.selectedCli;
      const at = str(row.recordedAt) ?? now;
      const toolName = str(data.tool_name);

      // Opened and closed, tracked by the id the tool call carries. A call
      // with no id cannot be paired, so it is not counted either way.
      const useId = str(data.tool_use_id);
      if (useId) {
        // A call from before the person stopped the session is over, whether
        // or not anything ever wrote its `PostToolUse`.
        if (name === "PreToolUse" && !(stoppedAt && at <= stoppedAt)) {
          inFlight.set(useId, { at, ...(toolName ? { toolName } : {}) });
        } else if (name === "PostToolUse") inFlight.delete(useId);
      }

      /*
        A turn that ended took its tool calls with it.

        The comment above `IN_FLIGHT_TTL_MS` is right that nothing retracts a
        `PreToolUse` — and wrong that the session never says so. A `Stop` is
        the agent handing control back, and an agent cannot do that with a
        foreground tool still waiting on a result; whatever opened before it
        has either closed or never will. The case that found this was a
        subagent's `Bash` whose `PostToolUse` never landed, written under the
        parent's session id: one line, and the run it belonged to was shown
        working for the whole thirty minutes the TTL allows, thirty-four
        minutes after the session had actually finished — because each poll's
        "still working" moved the clock the settle rule reads, so the five
        quiet minutes it needs never accrued (ANT-119).

        Only calls from before the stop are closed. Lines interleave, and a
        call the *next* turn opened is not this turn's to end.
      */
      if (name === "Stop" || name === "SessionEnd") {
        for (const [id, call] of inFlight) if (call.at <= at) inFlight.delete(id);
      }
      // A session that has ended has nothing outstanding, whatever its last
      // record listed, and it is the one thing this channel can settle a run
      // on outright: the silence after it is not a tool running.
      if (name === "SessionEnd") {
        delegated.clear();
        const why = str(data.reason);
        ended = {
          at,
          cli,
          detail: why ? `The session ended (${why}).` : "The session ended.",
        };
      }

      const base: ObservationEventDraft = {
        at,
        cli,
        source: "hook",
        channel: `${cli}:hook`,
        sessionId: run.detectedSessionId,
        kind,
        title: TITLE[name] ?? toolName ?? name,
        ...(toolName ? { toolName } : {}),
        ...(str(data.tool_use_id) ? { toolUseId: str(data.tool_use_id) as string } : {}),
        ...(typeof data.duration_ms === "number" ? { durationMs: data.duration_ms } : {}),
      };

      if (kind === "tool.start" || kind === "tool.end") {
        const target = toolTarget(toolName, data.tool_input);
        events.push({
          ...base,
          title: toolName ?? "A tool",
          ...(target ? { detail: target } : {}),
          ...(kind === "tool.end" ? { ok: data.tool_response !== undefined } : {}),
        });
        continue;
      }

      if (name === "Notification") {
        // The one field here is the CLI's own short message about what it is
        // waiting for. It is written for a person to read, not model prose.
        events.push({ ...base, ...(str(data.message) ? { detail: str(data.message) as string } : {}) });
        continue;
      }

      if (name === "Stop") {
        // The last assistant message is scanned for step markers and then
        // thrown away — the message itself is never stored or shown.
        const announced = parseStepMarkers(str(data.last_assistant_message) ?? "", {
          runId: run.anthillRunId,
          nonce: run.correlationNonce,
        });
        for (const blockId of announced) {
          events.push({ ...base, kind: "step.marker", title: "Step announced", detail: blockId, blockId });
        }
        // The agent's own word that it finished — the marker-line form of
        // `anthill done` — read off the same message. It outranks any silence
        // rule: nothing has to be waited out once the harness has said so.
        if (parseDoneMarker(str(data.last_assistant_message) ?? "", {
          runId: run.anthillRunId,
          nonce: run.correlationNonce,
        })) {
          ended = { at, cli, detail: "The harness reported the work as finished." };
        }
        events.push(base);
        continue;
      }

      events.push(base);
    }

    const newest = events.reduce<string | undefined>(
      (latest, event) => (latest && latest >= event.at ? latest : event.at),
      undefined,
    );
    const already = this.reportedAt.get(run.anthillRunId);
    const evidence: Evidence[] = [];
    if (newest && (!already || newest > already)) {
      this.reportedAt.set(run.anthillRunId, newest);
      evidence.push({ kind: "activity", sessionId, at: newest });
    }
    if (ended) {
      evidence.push({
        kind: "completed",
        sessionId,
        channel: `${ended.cli}:hook`,
        at: ended.at,
        detail: ended.detail,
      });
    }
    return {
      evidence: [...evidence, ...this.stillWorking(inFlight, delegated, sessionId, now)],
      events,
    };
  }

  /**
   * "Something is running" — said only while something demonstrably is.
   *
   * Reported at `now` rather than at the call's own moment, because that is
   * the claim: not that the session wrote at this instant, but that as of this
   * instant it has work outstanding. Calls too old to believe are dropped as
   * they are found, so a stale record cannot keep saying it forever.
   */
  private stillWorking(
    inFlight: Map<string, OpenCall>,
    delegated: Map<string, BackgroundTask>,
    sessionId: string,
    now: string,
  ): Evidence[] {
    let newest: { at: string; detail?: string } | undefined;
    const consider = (at: string, detail?: string) => {
      if (!newest || at > newest.at) newest = { at, ...(detail ? { detail } : {}) };
    };

    for (const [id, call] of inFlight) {
      if (this.tooOld(call.at, now)) {
        inFlight.delete(id);
        continue;
      }
      consider(call.at, call.toolName ? `${call.toolName} has been running since ${call.at}.` : undefined);
    }

    /*
      A delegation the session says it is waiting on.

      Expired on the same clock and for the same reason as an open tool call:
      nothing ever retracts either. The session ANT-75 was reported from ended
      with one still listed — a shell task called "Wait for fixture OCR tests
      to finish", carried for five hours, long after the work it named was
      over. Against that, the longest delegation that was genuinely running
      lasted eighty-one minutes, and it spent none of that time silent: its
      subagent's own hooks arrive under this session, so real work keeps
      saying so through the ordinary channel and does not need this one.
    */
    for (const [id, task] of delegated) {
      if (this.tooOld(task.since, now)) {
        delegated.delete(id);
        continue;
      }
      consider(
        task.since,
        task.description
          ? `The session is still waiting on "${task.description}".`
          : "The session is still waiting on work it handed to somebody else.",
      );
    }

    if (!newest) return [];
    return [
      {
        kind: "working",
        sessionId,
        at: now,
        since: newest.at,
        ...(newest.detail ? { detail: newest.detail } : {}),
      },
    ];
  }

  /**
   * Whether this log is carrying news about a run, as a matter of record.
   *
   * The transcript observer asks, because what it may infer from silence
   * depends on whether anything else is listening (ANT-75).
   */
  watching(runId: string): boolean {
    return this.covered.has(runId);
  }

  /**
   * Drop what this run had outstanding, because the session was stopped.
   *
   * The counterpart of a `Stop` closing its turn's calls (ANT-119), for the
   * ending this channel cannot see: an interrupt fires no hook, so only the
   * transcript knows, and a call the interrupt killed will never report back.
   * Cursors are untouched — the log is still read, there is simply nothing
   * left to claim.
   *
   * The moment of the stop is kept, not just applied: clearing what had
   * already been read is no defence against reading it again. A run bound by
   * a plugin learns of the stop on the same poll that first reads the log, so
   * the call the stop killed was ingested *after* the clearing and claimed the
   * session was working from a `PreToolUse` written before the person pressed
   * the key (ANT-122).
   */
  stopped(runId: string, at: string): void {
    this.open.get(runId)?.clear();
    this.background.get(runId)?.clear();
    const known = this.stoppedAt.get(runId);
    if (!known || known < at) this.stoppedAt.set(runId, at);
  }

  /**
   * Whether this log is holding a claim that work is outstanding for a run:
   * a call opened and not closed, or a delegation the session last listed as
   * running — either still young enough to be believed.
   *
   * The same records `stillWorking` reports from, asked without reporting,
   * so the transcript can decline to infer an ending from silence that this
   * channel says is a tool running or a delegate working (ANT-119).
   */
  waiting(runId: string, now: string): boolean {
    for (const call of this.open.get(runId)?.values() ?? []) if (!this.tooOld(call.at, now)) return true;
    for (const task of this.background.get(runId)?.values() ?? []) if (!this.tooOld(task.since, now)) return true;
    return false;
  }

  /** Whether a record has gone uncorroborated for longer than it is believed. */
  private tooOld(since: string, now: string): boolean {
    return Date.parse(now) - Date.parse(since) > IN_FLIGHT_TTL_MS;
  }
}
