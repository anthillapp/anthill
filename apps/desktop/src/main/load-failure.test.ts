/**
 * The blank window, and why it was blank.
 *
 * `electron-vite dev` restarts Electron whenever the main process is rebuilt.
 * If the watcher behind it has died, the restarted window points at a dev
 * server that is no longer listening — the log said `ERR_CONNECTION_REFUSED`
 * four times over and the window said nothing, because both load calls
 * discarded their promise with `void`.
 */

import { describe, expect, it } from "vitest";

import {
  isRealLoadFailure,
  loadFailureAdvice,
  loadFailurePage,
  loadFailureUrl,
} from "./load-failure.js";

const refused = {
  url: "http://localhost:5173/",
  error: "ERR_CONNECTION_REFUSED",
  dev: true,
};

describe("which failures earn a page", () => {
  it("counts a main-frame failure", () => {
    expect(isRealLoadFailure(-102, true)).toBe(true);
  });

  /** A navigation replaced by another one. Routine, and not an error. */
  it("ignores an aborted navigation", () => {
    expect(isRealLoadFailure(-3, true)).toBe(false);
  });

  it("ignores a subframe, which is not the window failing", () => {
    expect(isRealLoadFailure(-102, false)).toBe(false);
  });
});

describe("what the page says", () => {
  it("names the address it tried and what came back", () => {
    const page = loadFailurePage(refused);
    expect(page).toContain("http://localhost:5173/");
    expect(page).toContain("ERR_CONNECTION_REFUSED");
  });

  it("points a dev build at the server rather than at the app", () => {
    expect(loadFailureAdvice(refused)).toContain("development server is not answering");
    expect(loadFailureAdvice(refused)).toContain("npm run dev:desktop");
  });

  it("tells a packaged build the truth about itself instead", () => {
    const advice = loadFailureAdvice({ ...refused, dev: false });
    expect(advice).toContain("could not read its own files");
    expect(advice).not.toContain("npm run dev:desktop");
  });

  it("does not frighten anybody about unsaved work", () => {
    expect(loadFailurePage(refused)).toContain("Nothing has been lost");
  });

  /** It has to render in exactly the situation where nothing else does. */
  it("carries no script and fetches nothing", () => {
    const page = loadFailurePage(refused);
    expect(page).not.toContain("<script");
    expect(page).not.toContain("http://localhost:5173/\" rel");
    expect(page).not.toMatch(/<link[^>]+href/);
  });

  it("escapes what it was handed rather than pasting it into the markup", () => {
    const page = loadFailurePage({
      url: '"><script>alert(1)</script>',
      error: "<b>boom</b>",
      dev: true,
    });
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).not.toContain("<b>boom</b>");
    expect(page).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });

  it("is something loadURL will accept", () => {
    expect(loadFailureUrl(refused).startsWith("data:text/html;charset=utf-8,")).toBe(true);
  });
});
