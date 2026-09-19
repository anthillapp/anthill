/**
 * Where the exchange keeps things, and how an id from elsewhere becomes a
 * directory name.
 *
 * Every path in the store is built here rather than joined at the point of use,
 * because two programs write into this tree — the app and the MCP server — and
 * a layout they each derive separately is a layout they will eventually derive
 * differently. There is one description of the shape and both sides import it.
 *
 * ```
 * <dataDir>/exchange/
 *   inbox/
 *     <key>.json              a display or bind request, dropped by the server
 *     done/<key>.json         consumed, kept so a retry is recognisable
 *   workflows/<workflowId>/
 *     identity.json           created once: who asked, what they asked for, when
 *     workflow.json           the working copy the editor opens and saves
 *     revisions/0001.json     immutable snapshots, zero-padded so listing sorts
 *     revisions/0001.ready    readiness, created by the app when the user says so
 *     revisions/0001.revoked  the user taking that readiness back, beside it
 *     bindings/<runId>.json   created by the server when a run binds
 * ```
 *
 * The one thing this module refuses to do is trust an id. Workflow ids, run ids
 * and inbox keys all arrive over MCP from a process Anthill did not start, and a
 * workflow id of `../../../etc` would otherwise be a path. Everything that
 * becomes a segment goes through `safeSegment` first.
 */

import { join } from "node:path";

/** The exchange's own directory inside whichever data directory it is given. */
export const EXCHANGE_DIR_NAME = "exchange";

/**
 * The root of the exchange tree under a data directory.
 *
 * Exported so the app, the server and a test can all name the tree without
 * re-deriving it — the store itself is constructed from the data directory and
 * does this join internally.
 */
export function exchangeRoot(dataDir: string): string {
  return join(dataDir, EXCHANGE_DIR_NAME);
}

/**
 * Make an arbitrary id safe to use as a single path segment.
 *
 * Copied from the run store, which needs the same guarantee for the same
 * reason: ids come from workflow documents and from agent output, and they must
 * never be able to escape the root. Dots are dropped along with separators so
 * no segment can ever become "." or "..", and so the extension this store
 * appends is the only one in the file name.
 *
 * Not shared with the run store's copy on purpose. That one is private to a
 * package this one does not depend on, and the sanitising rule is three lines
 * whose value is entirely in being applied rather than in being written once.
 */
export function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

/**
 * The segment a workflow id becomes.
 *
 * The fallback is deliberately a constant rather than something derived: an id
 * made entirely of characters this rejects is an id nothing else in Anthill
 * could have produced, and one shared landing place for all of them means the
 * second such handover collides with the first and is reported as a conflict
 * rather than quietly filed somewhere new.
 */
export function workflowSegment(workflowId: string): string {
  return safeSegment(workflowId, "unnamed-workflow");
}

export function workflowsDir(root: string): string {
  return join(root, "workflows");
}

export function workflowDir(root: string, workflowId: string): string {
  return join(workflowsDir(root), workflowSegment(workflowId));
}

export function identityPath(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "identity.json");
}

/**
 * The file the editor opens, saves and prompts about.
 *
 * The one file in this tree that is not a record: it is an ordinary workflow
 * document living inside the store's directory so that `anthill://workflow/<id>`
 * resolves to a path the editor already knows how to open. The store never
 * writes it and never reads it — revisions are what the store keeps — and it is
 * named here only so that the app and the server agree on where it is.
 */
export function workingCopyPath(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "workflow.json");
}

export function revisionsDir(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "revisions");
}

export function revisionPath(root: string, workflowId: string, revision: number): string {
  return join(revisionsDir(root, workflowId), `${revisionStem(revision)}.json`);
}

export function readyPath(root: string, workflowId: string, revision: number): string {
  return join(revisionsDir(root, workflowId), `${revisionStem(revision)}.ready`);
}

/**
 * Where the user's withdrawal of an approval goes.
 *
 * Beside the approval it undoes rather than in place of it, because nothing in
 * this store is ever deleted: a withdrawal is a second record about the same
 * revision, and the pair is the whole of what the user decided about it. A
 * reader that found only the approval and inferred the rest would be inferring
 * from an absence, which is precisely what an unlink in a tree three processes
 * write into cannot be trusted to mean.
 */
export function revokedPath(root: string, workflowId: string, revision: number): string {
  return join(revisionsDir(root, workflowId), `${revisionStem(revision)}.revoked`);
}

export function bindingsDir(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "bindings");
}

export function bindingPath(root: string, workflowId: string, runId: string): string {
  return join(bindingsDir(root, workflowId), `${safeSegment(runId, "unnamed-run")}.json`);
}

export function inboxDir(root: string): string {
  return join(root, "inbox");
}

export function inboxDoneDir(root: string): string {
  return join(inboxDir(root), "done");
}

export function inboxPath(root: string, key: string): string {
  return join(inboxDir(root), `${inboxSegment(key)}.json`);
}

export function inboxDonePath(root: string, key: string): string {
  return join(inboxDoneDir(root), `${inboxSegment(key)}.json`);
}

function inboxSegment(key: string): string {
  return safeSegment(key, "unnamed-drop");
}

/**
 * A revision number as it appears in a file name.
 *
 * Zero-padded to four digits so an alphabetical directory listing is already in
 * revision order for every workflow anybody will ever have. Past 9999 the
 * padding stops helping, which is why nothing in this package relies on the
 * listing's order: the numbers are parsed out and sorted numerically.
 */
export function revisionStem(revision: number): string {
  return String(revision).padStart(4, "0");
}

/**
 * The revision number a file name carries, or `undefined` if it carries none.
 *
 * Used to fold a directory listing into a workflow's history, so it has to
 * reject anything that is not a revision: the house atomic-write pattern leaves
 * `*.tmp` files beside their targets, and a partially written snapshot read as
 * revision 3 would be worse than not reading it at all.
 */
export function revisionFromFileName(name: string): number | undefined {
  const match = /^(\d{4,})\.json$/.exec(name);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

/** The revision number a `.ready` marker is about, or `undefined`. */
export function revisionFromReadyFileName(name: string): number | undefined {
  const match = /^(\d{4,})\.ready$/.exec(name);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

/**
 * The revision number a `.revoked` marker is about, or `undefined`.
 *
 * An approval and its withdrawal share a stem, so this and the reader above
 * are anchored at both ends: one listing pass asks both questions of every
 * name, and a pattern loose at the tail would answer the other one's.
 */
export function revisionFromRevokedFileName(name: string): number | undefined {
  const match = /^(\d{4,})\.revoked$/.exec(name);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

/** The inbox key a drop's file name carries, or `undefined` for anything else. */
export function keyFromInboxFileName(name: string): string | undefined {
  // Only `.json`, and nothing that starts with a dot. The atomic-write pattern
  // used everywhere else in Anthill writes `<name>.<pid>.<seq>.tmp` beside its
  // target, so a reader that takes every file in the directory will sooner or
  // later read half of one.
  if (!name.endsWith(".json") || name.startsWith(".")) return undefined;
  const key = name.slice(0, -".json".length);
  return key.length > 0 ? key : undefined;
}
