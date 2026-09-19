/**
 * The one file in the exchange the store does not own.
 *
 * `workflow.json` inside a handed-over workflow's directory is an ordinary
 * workflow document. The editor opens it by path, saves it by path and
 * remembers it in the recent list, and none of that had to learn what a
 * handover is — which is why the app materialises a submitted revision into a
 * file instead of teaching the editor a second way to load a document. The
 * store names the file and never touches it, so one job is left over: writing a
 * submitted revision into it, because without that there is nothing to open.
 *
 * It lives here rather than in `index.ts` because it needs no Electron, and
 * `index.ts` cannot be loaded under vitest.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
 * An ordinary write, not the store's exclusive create. This is the file that is
 * meant to be replaced: the store's revisions are the history, and the working
 * copy is only whatever is currently open.
 */
export async function writeWorkingCopy(path: string, workflow: Workflow): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
}
