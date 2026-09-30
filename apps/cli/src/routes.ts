/**
 * `/workflow/<id>`: a tab opened for one handed-over workflow (ANT-228).
 *
 * Shared by the server, which serves the app shell there, and the page, which
 * reads the id back out of its own URL and hands it to the bridge. The bridge
 * checks it and looks it up in the exchange as it would an
 * `anthill://workflow/<id>` link. One segment only, so nothing below it is
 * served as the shell.
 */
export const WORKFLOW_ROUTE = /^\/workflow\/([^/]+)$/;

/** The workflow id a path names, decoded, or `undefined` for any other path. */
export function routedWorkflowId(pathname: string): string | undefined {
  const match = WORKFLOW_ROUTE.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}
