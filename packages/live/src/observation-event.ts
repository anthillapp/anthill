/**
 * One thing Anthill observed on this machine, recorded exactly once.
 *
 * Anthill did not start the session and is not talking to it. Everything here
 * came out of a file the user's own CLI wrote: a hook payload, a Claude Code
 * transcript, a Codex rollout. So an `ObservationEvent` is a claim about *a
 * local record*, never about what the agent is thinking or intending, and the
 * type is shaped to make the difference impossible to blur:
 *
 * - `source` and `channel` say which record it came out of, so a hook event and
 *   a line read out of a transcript are never confused for one another.
 * - `blockId` is set only by an explicit Anthill step marker. No other code path
 *   may fill it in, which is what keeps "the agent said it was on this step"
 *   from drifting into "Anthill guessed".
 * - There is no field for prose the model produced for itself. Titles and
 *   details are drawn from tool names, event names, and metadata the CLI wrote
 *   down; the adapters never copy message bodies, file contents, or reasoning.
 *
 * Events are appended to a per-run journal and never edited, so the page can be
 * rebuilt from the log alone and a replay is the same fold as the live view.
 */

import type { MarkerCli } from "./marker.js";

/** Which kind of local record an event was read out of. */
export type ObservationSource =
  /** A lifecycle hook the user installed, invoked by their CLI. */
  | "hook"
  /** Claude Code's own session transcript. */
  | "transcript"
  /** Codex's own rollout file. */
  | "rollout"
  /** pi's own session file. */
  | "session"
  /** Anthill's own bookkeeping, not the CLI's. */
  | "anthill";

/**
 * What happened, in Anthill's vocabulary rather than either vendor's.
 *
 * Kept small on purpose. Every kind here is something both a person and the
 * workflow graph can act on; anything finer would be transcript detail, which this
 * milestone deliberately does not show.
 */
export type ObservationKind =
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "step.marker"
  /** One line of what the agent said to the person watching. Never reasoning. */
  | "message"
  | "tool.start"
  | "tool.end"
  | "subagent.start"
  | "subagent.end"
  | "notification"
  | "turn.end"
  /**
   * Token usage the harness recorded for its own work.
   *
   * Journal-only: the feed never draws a card for it — usage is metadata about
   * things that happened, not a thing that happened — but the metrics fold
   * reads it, and attribution applies to it like to anything else.
   */
  | "usage"
  | "error";

export type ObservationEvent = {
  /** The Anthill run this belongs to. */
  runId: string;
  /** Monotonic within the run. The ordering and de-duplication key. */
  seq: number;
  /** When the CLI recorded it, when the record says. */
  at: string;
  /** When Anthill read it. Different from `at` for anything recovered late. */
  recordedAt: string;

  cli: MarkerCli;
  source: ObservationSource;
  /** e.g. `claude-code:hook`, `codex:rollout`. Shown in the evidence line. */
  channel: string;
  /** The CLI's own session id, once known. */
  sessionId?: string;

  kind: ObservationKind;
  /** A safe one-line label. Never model prose. */
  title: string;
  /**
   * A safe second line: a tool's target, a duration, an event name.
   *
   * For a `message` it is the agent's own words, cut down by `messageExcerpt`
   * — the one place a record's prose reaches the page, and the reason that
   * function removes rather than selects.
   */
  detail?: string;

  toolName?: string;
  /** Pairs a start with its end. Both vendors provide one. */
  toolUseId?: string;
  /** Set when the work was delegated; the delegating call's id. */
  parentToolUseId?: string;
  /** The agent or subagent the record named. Not inferred. */
  agentName?: string;
  /**
   * Who wrote it, when the record says who.
   *
   * Separate from `agentName`, which exists for *attribution* — mapping work
   * to a workflow block by the agent that carries it. This is authorship, and
   * it is only ever what the record states: the root session, or a subagent
   * the record itself identified. Absent means the record did not say, and
   * the page says so rather than reaching for the block that happens to be
   * active. Attributing a message to whoever was working nearby is exactly
   * the kind of confident wrong answer this whole feature exists to avoid.
   */
  author?: { kind: "main" } | { kind: "subagent"; name?: string };
  durationMs?: number;
  /** Whether the recorded step succeeded, when the record says. */
  ok?: boolean;
  /**
   * Incremental token usage, exactly as the harness recorded it.
   *
   * `in` counts everything the model read for this slice — fresh input and
   * cache traffic alike — and `out` what it wrote. Always the harness's own
   * numbers, never an estimate, and absent whenever the record carries none:
   * missing usage is unavailable, not zero.
   */
  tokens?: { in: number; out: number };

  /**
   * The workflow block, and only ever from an explicit Anthill step marker.
   *
   * Nothing else writes this field. Attribution by agent name or by position
   * lives in `attribution.ts` and is reported separately, so a guess can never
   * arrive here looking like something the agent stated.
   */
  blockId?: string;

  /**
   * Why this record means the work is over, when it does.
   *
   * Set only by an adapter that read an explicit ending: Codex's own
   * `task_complete` (`task_complete`), or the harness saying the workflow is
   * finished — the `ANTHILL-DONE` line in a reply or a Stop hook's last
   * message, or `anthill done` (`done`). A turn that merely ended carries
   * nothing here: that is the CLI yielding, which can as well be a question
   * (ANT-158, ANT-161).
   *
   * Journals written before this field existed lack it; `completionOf` reads
   * the two records that already meant it.
   */
  completion?: "task_complete" | "done";

  /**
   * Other channels that recorded this same action.
   *
   * Synthesized by `mergeChannels` and never written to the journal, which
   * keeps each channel's record whole. It is here so a card can say it was
   * read from both places rather than picking one and hiding the other.
   */
  alsoFrom?: string[];
};

/** A stable identity for an event, so a re-read of a file cannot duplicate it. */
export function eventFingerprint(event: Omit<ObservationEvent, "seq" | "recordedAt">): string {
  return [
    event.channel,
    // Reports identify the run, not a vendor session. Resolving a host id
    // must not replay those reports as new step passes after restart.
    event.channel === "anthill:report" ? event.runId : event.sessionId ?? "-",
    event.kind,
    event.at,
    event.toolUseId ?? event.blockId ?? event.title,
  ].join("|");
}

/**
 * The explicit ending a record carries, if any.
 *
 * Only the session's own records count: a subagent finishing is a delegate
 * handing back, not the run ending. Older journals are read by the two shapes
 * that already meant an ending — `anthill done`'s report, and the `turn.end`
 * the Codex adapter wrote for `task_complete` and for nothing else.
 */
export function completionOf(event: ObservationEvent): ObservationEvent["completion"] {
  if (event.author?.kind === "subagent") return undefined;
  if (event.completion) return event.completion;
  if (event.channel === "anthill:report" && event.kind === "session.end") return "done";
  if (event.channel === "codex:rollout" && event.kind === "turn.end") return "task_complete";
  return undefined;
}
