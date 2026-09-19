/**
 * The link that opens a handed-over workflow in Anthill.
 *
 * Every result that has something to open carries one, because it is the only
 * thing in the result a *person* can act on. The harness reads run ids and
 * revision numbers; the user sitting next to it gets a URL they can click, and
 * it works whether or not the app is already running.
 *
 * Which is why building one is not the same as offering one, and the handlers
 * decide the second. An id can be turned into a URL whether or not anything is
 * stored under it, and a link handed over after "no workflow of that id" would
 * be the one actionable-looking line in an answer that has nothing to act on —
 * or, worse, after an id clash, a link that opens the *other* workflow holding
 * the name. So nothing here checks, and no refusal carries a link.
 *
 * The id is percent-encoded even though the store would sanitise it anyway.
 * The two do different jobs and must not be confused: `workflowSegment` decides
 * what a directory is called and is deliberately lossy, whereas this has to
 * survive a round trip through a URL parser and come back as the id that was
 * submitted. A workflow called `a/b` encodes here and resolves there; unencoded
 * it would read as a path and open nothing.
 *
 * The other half of this — turning the URL back into a workflow id when macOS
 * or Windows hands it to the app — belongs to the desktop's main process, which
 * is the only thing that receives one.
 */

export const WORKFLOW_URL_SCHEME = "anthill";

export function workflowUrl(workflowId: string): string {
  return `${WORKFLOW_URL_SCHEME}://workflow/${encodeURIComponent(workflowId)}`;
}
