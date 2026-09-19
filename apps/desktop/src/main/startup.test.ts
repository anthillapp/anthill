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
