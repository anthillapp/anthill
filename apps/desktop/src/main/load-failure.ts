/**
 * What to show when the window cannot load the app at all.
 *
 * `loadURL` and `loadFile` return promises, and both call sites discarded them
 * with `void`. So when a load failed there was no error page, no message and
 * no log the author would ever see — just a window with a title bar and
 * nothing in it, which reads as "Anthill is broken" whatever the actual cause.
 *
 * In development the actual cause is nearly always mundane and recoverable:
 * `electron-vite dev` restarts Electron whenever the main process is rebuilt,
 * and if the watcher behind it has since died, the restarted window points at a
 * dev server that is no longer listening. The log said
 * `ERR_CONNECTION_REFUSED` four times over; the window said nothing.
 *
 * This is the whole fix in principle: an empty window is a claim, and it is the
 * wrong one. A window that cannot load says so, says which address it tried,
 * says what the system told it, and says the one thing worth doing next.
 *
 * The page is deliberately inert — no scripts, no network, no styling that
 * could itself fail to load. It has to work in exactly the situation where
 * nothing else does.
 */

/** Codes that are not failures worth a page. */
const IGNORED = new Set([
  // A navigation replaced by another one. Routine, and not an error.
  -3,
]);

export function isRealLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && !IGNORED.has(errorCode);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type LoadFailure = {
  /** Where the window was trying to go. */
  url: string;
  /** Chromium's own description, e.g. ERR_CONNECTION_REFUSED. */
  error: string;
  /** True when a dev server should have been answering. */
  dev: boolean;
};

/**
 * The advice, which is the only part that differs between the two builds.
 *
 * A packaged build failing to load its own files is a broken installation and
 * nothing the author can restart their way out of; a dev build failing is
 * almost always the server, and saying so saves them debugging the app.
 */
export function loadFailureAdvice(failure: LoadFailure): string {
  return failure.dev
    ? "The development server is not answering. It stops when `npm run dev:desktop` stops – including when only the Electron window was closed and restarted. Start it again, then press ⌘R here."
    : "Anthill could not read its own files. The installation looks incomplete – replacing the app is the fix. Pressing ⌘R will try again in case this was momentary.";
}

/** A page that can render when nothing else on this machine will. */
export function loadFailurePage(failure: LoadFailure): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Anthill could not load</title>",
    "<style>",
    "body{margin:0;padding:56px 48px;font:14px/1.6 -apple-system,BlinkMacSystemFont,",
    "'Segoe UI',sans-serif;color:#201e1d;background:#f8f7f7}",
    "h1{font-size:19px;margin:0 0 10px}",
    "p{margin:0 0 14px;max-width:52ch}",
    "dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;max-width:52ch}",
    "dt{color:#8a8584}",
    "dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;",
    "word-break:break-all}",
    "</style></head><body>",
    "<h1>Anthill could not load its own screen</h1>",
    `<p>${escapeHtml(loadFailureAdvice(failure))}</p>`,
    "<dl>",
    `<dt>Tried</dt><dd>${escapeHtml(failure.url)}</dd>`,
    `<dt>Result</dt><dd>${escapeHtml(failure.error)}</dd>`,
    "</dl>",
    "<p>Nothing has been lost. This window holds no unsaved work – it never got as far as opening any.</p>",
    "</body></html>",
  ].join("");
}

/** The page as something `loadURL` will accept. */
export function loadFailureUrl(failure: LoadFailure): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(loadFailurePage(failure))}`;
}
