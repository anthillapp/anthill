/**
 * That nothing in the main process can fail before somebody is told about it.
 *
 * The crash handlers are the app's only account of itself while it is starting:
 * there is no window yet, no page to put a notice in, and a double-clicked app
 * has no terminal to print to either. They were installed six lines below the
 * choice of data directory, which is the earliest thing in the file that can
 * throw — four shapes of `--data-dir` killed the app on the spot, with no box,
 * no log line and nothing on screen but the dock icon going away again.
 *
 * Order is the whole of the fix, and order is a property of the text, so the
 * text is what is checked. Electron is not importable here — `index.ts` reaches
 * for it at module load — so the source is read as data, the way the menu and
 * packaging rules are.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const main = readFileSync(resolve("src/main/index.ts"), "utf8");

/*
 * The names here are the ones ANT-95 actually removed. The list used to guard
 * `runCancel`, which was never a channel, while leaving out `runtimesDetect`,
 * `workspaceSelect` and `workspaceStatus`, which were three of the five that
 * went — so re-registering any of those would have walked straight past it.
 */
it("retains read-only history handlers without registering runner controls", () => {
  expect(main).toContain("handle(IpcChannel.runGet,");
  expect(main).toContain("handle(IpcChannel.runList,");
  for (const channel of [
    "runStart",
    "approvalRespond",
    "runtimesDetect",
    "workspaceSelect",
    "workspaceStatus",
  ]) {
    expect(main, channel).not.toMatch(new RegExp(`handle\\(\\s*IpcChannel\\.${channel}\\b`));
  }
  // The push channel the renderer subscribed to, which no object lists.
  expect(main).not.toMatch(/webContents\.send\(\s*RUN_EVENT/);
  expect(main.slice(main.indexOf("void app.whenReady()"))).not.toContain("createServices(");
});

it("installs the crash handlers before anything that can crash", () => {
  const handler = main.indexOf('process.on("uncaughtException"');
  const rejection = main.indexOf('process.on("unhandledRejection"');
  const dataDirectory = main.indexOf("const USER_DATA_DIR =");
  expect(handler).toBeGreaterThan(-1);
  expect(rejection).toBeGreaterThan(-1);
  expect(dataDirectory).toBeGreaterThan(-1);
  expect(handler).toBeLessThan(dataDirectory);
  expect(rejection).toBeLessThan(dataDirectory);
});

/*
 * `showErrorBox` is the one dialog Electron allows before `ready`, and a
 * refusal to choose a data directory is always before `ready`. Anything else
 * would be a message posted to a window that is never going to exist.
 */
it("puts a refused data directory in front of the user and then quits", () => {
  const chooser = main.slice(main.indexOf("function chooseDataDirectory()"));
  const body = chooser.slice(0, chooser.indexOf("\n}\n"));
  expect(body).toContain("dialog.showErrorBox");
  expect(body).toContain("dataDirectoryRefusal");
  expect(body).toContain("app.exit(1)");
  expect(body.indexOf("dialog.showErrorBox")).toBeLessThan(body.indexOf("app.exit(1)"));
});

/*
 * A channel the preload bridges and main never serves fails only when someone
 * uses it, with "No handler registered" swallowed by the page's catch. The
 * handover sheet's decline was that for a whole release (ANT-146). So every
 * channel the preload invokes must have a handler in the main process.
 */
it("serves every channel the preload invokes", () => {
  const preload = readFileSync(resolve("src/preload/index.ts"), "utf8");
  const invoked = [...preload.matchAll(/invoke\(\s*IpcChannel\.(\w+)/g)].map((match) => match[1]);
  expect(invoked.length).toBeGreaterThan(0);
  const unserved = invoked.filter((channel) => !new RegExp(`handle\\(\\s*IpcChannel\\.${channel}\\b`).test(main));
  expect(unserved).toEqual([]);
});

/*
 * ANT-150. On macOS, Electron 42's Chromium takes SIGTERM itself: the quit
 * starts, the window's close guard runs, and `process.on("SIGTERM")` never
 * does — so a dev restart with an unsaved workflow stopped on "Discard
 * changes?", the replacement gave up on the lock, and electron-vite went with
 * it. The replacement asking for the lock is what ends a quitting dev run.
 */
it("lets a quitting development run go when its replacement asks for the lock", () => {
  const start = main.indexOf('app.on("second-instance"');
  expect(start).toBeGreaterThan(-1);
  const handler = main.slice(start, main.indexOf("});", start));
  expect(handler).toMatch(/if \(quitting\) \{[\s\S]*if \(!app\.isPackaged\) app\.exit\(0\);[\s\S]*return;/);
});
