/**
 * The one file in the exchange the store does not own.
 *
 * `workflow.json` inside a handed-over workflow's directory is an ordinary
 * workflow document. The editor opens it by path, saves it by path and
 * remembers it in the recent list, and none of that had to learn what a
 * handover is — which is why the app materialises a submitted revision into a
 * file instead of teaching the editor a second way to load a document. The
 * store names the file and never touches it, so two jobs are left over: writing
 * a revision into it so there is something to open, and noticing when the user
 * saves it so the edit becomes the next revision.
 *
 * Both live here rather than in `index.ts` because neither needs Electron, and
 * `index.ts` cannot be loaded under vitest.
 */

import type { AddRevisionResult, ExchangeStore } from "@anthill/exchange-store";
import type { Workflow } from "@anthill/workflow-schema";
import { readWorkflowDocument } from "@anthill/workflow-exchange";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Put a revision's content where the editor will find it.
 *
 * Written the way `workflow:save` writes a workflow — two-space JSON with a
 * trailing newline — so that opening a handed-over workflow and saving it back
 * unchanged does not rewrite the whole file. The digest a revision is
 * recognised by is taken from the document rather than from the bytes, so the
 * formatting changes nothing about what is stored; it changes what somebody
 * reading the file with other tools sees.
 *
 * A delivery may repeat after a crash or a deep link. Only create a missing
 * file; an existing working copy belongs to the user, even if the inbox still
 * names the original revision. Publish complete bytes before exposing its name.
 */
export async function writeWorkingCopy(path: string, workflow: Workflow): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readWorkflowDocument(JSON.parse(await readFile(path, "utf8")));
      if (!existing.ok || existing.workflow.id !== workflow.id) {
        throw new Error("The working copy is unreadable or belongs to another workflow. It was not replaced.");
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Record a save of a handed-over workflow as the next revision.
 *
 * "Editing after binding creates revision N+1 and never modifies revision N" is
 * this function and nothing else. Whether the content actually changed is the
 * store's question — `addRevision` compares the digest against the head and
 * answers `unchanged` — so a save that changed nothing writes nothing, and a
 * revision a run is working from is safe because no path in the store writes
 * over a revision that exists.
 *
 * `undefined` when the saved path is not a handed-over workflow's working copy,
 * which is almost every save. The test is the exact path the store would name
 * for this document's own id rather than "somewhere under the exchange", so a
 * Save As that lands in the exchange directory is not mistaken for an edit of
 * what lives there; a document saved over another workflow's working copy is
 * refused by the store, which knows whose directory it is.
 */
export async function captureSavedRevision(
  store: ExchangeStore,
  path: string,
  workflow: Workflow,
): Promise<AddRevisionResult | undefined> {
  if (resolve(path) !== resolve(store.workingCopyPath(workflow.id))) return undefined;
  return store.addRevision(workflow.id, workflow, "user");
}
