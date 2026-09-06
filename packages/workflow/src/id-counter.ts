/**
 * Block and connection ids that are unique in time, not only in space.
 *
 * The numbers used to be derived from the nodes that happened to exist:
 * "lowest unused". Delete `agent-2` and the next block created is `agent-2`
 * again. Within one document at one moment every id is still distinct, so the
 * canvas never noticed (ANT-41).
 *
 * It matters because a block id is not a key into the current document. It is
 * printed into the prompt as `ANTHILL-STEP <run> <nonce> <block-id>` and read
 * back out of the session record, and the journal keeps a day of events tagged
 * with the block each was attributed to. A number that comes back on a
 * different block is an identity collision across time: events from a session
 * observed before the deletion resolve, afterwards, to a step that never did
 * that work. Attribution exists precisely so Anthill does not claim things it
 * cannot know, and this let it claim one quietly.
 *
 * So the document remembers the highest number it has ever handed out, per
 * prefix, in its own metadata — beside the format version and the agents, so
 * it travels with the file and survives save and load. Nothing is renumbered:
 * a workflow written before this simply starts counting above whatever it
 * already holds, which is what the old rule would have produced anyway.
 *
 * Ids stay `agent-7`, not a UUID. They are printed into prompts and read by
 * people who have to match one to a line in a terminal by eye.
 */

import type { Workflow } from "@anthill/workflow-schema";

const NAMESPACE = "workflow";
const KEY = "idSeq";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The highest number handed out per prefix, as the document remembers it. */
function stored(workflow: Workflow): Record<string, number> {
  const metadata = workflow.metadata;
  if (!isRecord(metadata)) return {};
  const bag = metadata[NAMESPACE];
  if (!isRecord(bag)) return {};
  const seq = bag[KEY];
  if (!isRecord(seq)) return {};
  const out: Record<string, number> = {};
  for (const [prefix, value] of Object.entries(seq)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[prefix] = Math.floor(value);
    }
  }
  return out;
}

/**
 * The number in `agent-7`, or nothing.
 *
 * An id that does not fit the shape at all — a hand-written one, or a
 * template's — is not a counter value and is left out rather than guessed at.
 */
function numberOf(id: string, prefix: string): number | undefined {
  if (!id.startsWith(`${prefix}-`)) return undefined;
  const tail = id.slice(prefix.length + 1);
  if (!/^\d+$/.test(tail)) return undefined;
  const value = Number(tail);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The next id for this prefix: past everything the document remembers, and
 * past everything it currently holds.
 *
 * `taken` is still consulted because the remembered counter can only be
 * trusted to be a floor — a workflow edited by hand, or written by an older
 * version, may carry ids the counter never saw.
 */
export function nextIdFor(
  workflow: Workflow,
  prefix: string,
  taken: Iterable<string>,
  /**
   * Which counter to draw from, when it is not simply the prefix.
   *
   * Agent profiles are named `agent-1` like agent *blocks* are, and the two
   * are separate identities in separate places — a workflow can hold a block
   * and a profile with the same name today. Sharing one counter would end
   * that, and would also renumber ids that are referenced from every step
   * that uses them, so they keep their own count (ANT-49).
   */
  counter: string = prefix,
): string {
  const used = new Set(taken);
  let highest = stored(workflow)[counter] ?? 0;
  for (const id of used) {
    const value = numberOf(id, prefix);
    if (value !== undefined && value > highest) highest = value;
  }
  let index = highest + 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

/**
 * Record ids the document now holds, so their numbers are never handed out
 * again — including after the thing holding them is deleted.
 *
 * Called where ids enter the document rather than where they are minted, so
 * an id supplied from outside — a template, a draft, a paste — is remembered
 * on the same terms as one this module chose.
 */
export function rememberIds(workflow: Workflow, ...ids: string[]): Workflow {
  return rememberIdsUnder(workflow, undefined, ids);
}

/**
 * The same, for ids counted somewhere other than under their own prefix.
 *
 * `counter` names the tally; the prefix is still read off each id, so the ids
 * themselves are unchanged.
 */
export function rememberIdsUnder(
  workflow: Workflow,
  counter: string | undefined,
  ids: readonly string[],
): Workflow {
  const seq = { ...stored(workflow) };
  let changed = false;
  for (const id of ids) {
    const dash = id.lastIndexOf("-");
    if (dash <= 0) continue;
    const prefix = id.slice(0, dash);
    const value = numberOf(id, prefix);
    if (value === undefined) continue;
    const key = counter ?? prefix;
    if ((seq[key] ?? 0) >= value) continue;
    seq[key] = value;
    changed = true;
  }
  if (!changed) return workflow;

  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = isRecord(metadata[NAMESPACE]) ? { ...(metadata[NAMESPACE] as object) } : {};
  return {
    ...workflow,
    metadata: { ...metadata, [NAMESPACE]: { ...bag, [KEY]: seq } },
  };
}
