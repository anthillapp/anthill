/**
 * One action, however many channels wrote it down.
 *
 * A Claude Code session with hooks installed is described twice: the hook log
 * records a tool call as it happens, and the transcript records the same call
 * when the assistant message lands. Both are journalled — deliberately, because
 * they are separate evidence and the journal is the evidence record — and
 * everything downstream counted them separately. One session produced 21
 * transcript tool starts and 11 hook tool starts, and the feed drew a card for
 * each: every action twice, the count doubled, and a step announced once shown
 * as "pass 2" because the graph saw two announcements (ANT-48).
 *
 * So the journal keeps both records and every fold over it sees one action.
 * The merge is a union, not a preference: the hook knows how long a call took
 * and the transcript knows what it was aimed at, and dropping either would
 * trade one wrong feed for another.
 *
 * Pure and clock-free, like every other fold here: two records are compared
 * against each other, never against the time now.
 */

import type { ObservationEvent } from "./observation-event.js";

/**
 * How far apart two records of one action may be.
 *
 * Only used where there is no id to pair on. The two channels write within a
 * few hundred milliseconds of each other — a hook fires around the call, the
 * transcript records the message that contained it — so this is generous by an
 * order of magnitude and still far short of a person submitting two prompts.
 */
const SAME_MOMENT_MS = 3_000;

/** Kinds that carry no id and are still written by both channels. */
const PAIRABLE_WITHOUT_ID = new Set(["prompt.submit", "step.marker", "turn.end", "session.start"]);

/**
 * What identifies the action a record is about.
 *
 * `toolUseId` is the harness's own id for the call and both channels report
 * it, which is why the feed could already pair a start with its end by it.
 * Nothing else needs inventing.
 */
function identity(event: ObservationEvent): string | undefined {
  if (event.toolUseId) return `${event.kind}|${event.toolUseId}`;
  if (PAIRABLE_WITHOUT_ID.has(event.kind)) {
    return `${event.kind}|${event.blockId ?? event.detail ?? ""}`;
  }
  return undefined;
}

/**
 * Whether these two records are the same action seen twice.
 *
 * The channels must differ. Two records from *one* channel are two things that
 * happened: a harness that ran the same tool twice wrote it twice, and folding
 * those together would hide work rather than reveal it.
 */
function sameAction(first: ObservationEvent, second: ObservationEvent): boolean {
  if (first.channel === second.channel) return false;
  if (first.sessionId && second.sessionId && first.sessionId !== second.sessionId) return false;
  if (second.toolUseId) return true;
  return Math.abs(Date.parse(second.at) - Date.parse(first.at)) <= SAME_MOMENT_MS;
}

/** The fields one record can fill in for another, and how much they are worth. */
function absorb(into: ObservationEvent, from: ObservationEvent): ObservationEvent {
  const alsoFrom = [...(into.alsoFrom ?? []), from.channel].filter(
    (channel, index, all) => channel !== into.channel && all.indexOf(channel) === index,
  );
  return {
    ...into,
    // A record that names a duration measured it; one that does not was going
    // to have it guessed from the gap between two of its own records.
    ...(into.durationMs === undefined && from.durationMs !== undefined
      ? { durationMs: from.durationMs }
      : {}),
    ...(into.detail === undefined && from.detail !== undefined ? { detail: from.detail } : {}),
    ...(into.toolName === undefined && from.toolName !== undefined
      ? { toolName: from.toolName }
      : {}),
    ...(into.agentName === undefined && from.agentName !== undefined
      ? { agentName: from.agentName }
      : {}),
    ...(into.author === undefined && from.author !== undefined ? { author: from.author } : {}),
    ...(into.toolUseId === undefined && from.toolUseId !== undefined
      ? { toolUseId: from.toolUseId }
      : {}),
    // A step id is the one thing that moves the graph, so a record that names
    // one is worth taking it from even when the first did not.
    ...(into.blockId === undefined && from.blockId !== undefined ? { blockId: from.blockId } : {}),
    // A failure recorded by either channel is a failure.
    ...(from.ok === false ? { ok: false } : {}),
    // The earliest record is when the action happened; the later one is when
    // the other channel got round to writing it down.
    at: Date.parse(from.at) < Date.parse(into.at) ? from.at : into.at,
    alsoFrom,
  };
}

/**
 * Collapse records that describe the same action into one, keeping every
 * field either of them knew.
 *
 * Order is preserved by the first record of each action: the second is not a
 * new moment, it is the same moment reported again.
 */
export function mergeChannels(events: readonly ObservationEvent[]): ObservationEvent[] {
  const merged: ObservationEvent[] = [];
  /** Where each action sits in `merged`, so a later record can be folded in. */
  const at = new Map<string, number>();

  for (const event of events) {
    const key = identity(event);
    const index = key === undefined ? undefined : at.get(key);
    if (index !== undefined && sameAction(merged[index], event)) {
      merged[index] = absorb(merged[index], event);
      continue;
    }
    if (key !== undefined) at.set(key, merged.length);
    merged.push(event);
  }
  return merged;
}
