/**
 * Where a workflow's agent files belong: the repository the session runs in.
 *
 * A harness fixes its list of callable agents when a session starts, so a file
 * written *during* the session is not callable in it (ANT-22). The only way
 * delegation happens on the first run is for the files to be on disk before
 * the author starts anything — which means Anthill has to know where, and has
 * to remember, or the author is asked the same question every time and skips
 * it exactly once.
 *
 * Stored in the workflow's own metadata, beside the format version and the
 * agents, so it survives a restart and travels with the file. Absent is a
 * perfectly good state: a prompt pasted into a machine Anthill cannot see has
 * no root to remember, and the bootstrap prompt already tells that session the
 * truth about what it can and cannot delegate to.
 */

import type { Workflow } from "@anthill/workflow-schema";

const NAMESPACE = "workflow";
const KEY = "runRoot";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The repository this workflow's agent files are written into, if one is known. */
export function runRoot(workflow: Workflow): string | undefined {
  const metadata = workflow.metadata;
  if (!isRecord(metadata)) return undefined;
  const bag = metadata[NAMESPACE];
  if (!isRecord(bag)) return undefined;
  const value = bag[KEY];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Remember a repository, or forget it by passing `undefined`. */
export function withRunRoot(workflow: Workflow, root: string | undefined): Workflow {
  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = isRecord(metadata[NAMESPACE]) ? { ...(metadata[NAMESPACE] as object) } : {};
  const next = { ...bag } as Record<string, unknown>;
  if (root && root.trim()) next[KEY] = root;
  else delete next[KEY];

  return { ...workflow, metadata: { ...metadata, [NAMESPACE]: next } };
}
