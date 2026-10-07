/**
 * That ⌘S is bound once, in the menu, and nowhere else.
 *
 * Save can be reached two ways — a menu accelerator, or a key handler in the
 * page — and having both is worse than having either: one press becomes two
 * saves racing the same file, and the later answer to arrive is the one left
 * on screen (ANT-59). The menu wins that choice because an accelerator is
 * consumed before the page sees the key, so it works with a text field focused
 * and can never fall through to the browser's own Save Page.
 *
 * Electron is not importable here — `index.ts` reaches for it at module load —
 * so the source is read as data, the way the packaging rules are.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(resolve("src/main/index.ts"), "utf8");

/** Every renderer file that could be listening for a keystroke. */
const renderer = ["WorkflowScreen.tsx"].map((file) =>
  readFileSync(resolve(`src/renderer/workflow/${file}`), "utf8"),
);

describe("Save in the File menu", () => {
  const fileMenu = main.slice(main.indexOf('label: "File"'), main.indexOf('role: "editMenu"'));

  it("is there, with the shortcut people go looking for", () => {
    expect(fileMenu).toContain('label: "Save"');
    expect(fileMenu).toContain('accelerator: "CmdOrCtrl+S"');
  });

  it("asks a window to save rather than saving on its behalf", () => {
    expect(fileMenu).toContain("SAVE_WORKFLOW_CHANNEL");
  });

  it("offers Reveal in Finder (Show in Folder off macOS), initially unavailable, through the active window", () => {
    const reveal = fileMenu.slice(fileMenu.indexOf('id: "reveal-workflow"'));
    expect(reveal).toContain('label: process.platform === "darwin" ? "Reveal in Finder" : "Show in Folder"');
    // Off until the page says there is a file to show; kept outside the menu
    // so rebuilding it for an update's label does not switch it back on or off.
    expect(reveal).toContain("enabled: workflowRevealable");
    expect(main).toContain("let workflowRevealable = false;");
    expect(reveal).toContain("REVEAL_WORKFLOW_CHANNEL");
    expect(reveal).toContain("BrowserWindow.getFocusedWindow()");
  });

  /** The role's own File menu has no Save in it, which is why it was dropped. */
  it("does not fall back to the stock File menu", () => {
    expect(main).not.toContain('{ role: "fileMenu" }');
  });

  it("keeps Close Window, which the stock menu provided", () => {
    expect(fileMenu).toContain('role: "close"');
  });
});

describe("the page does not bind it a second time", () => {
  it("has no ⌘S handler of its own", () => {
    for (const source of renderer) {
      // A handler would have to test the key; ⌘Z's does exactly this.
      expect(source).not.toMatch(/key\.toLowerCase\(\)\s*!==\s*"s"/);
      expect(source).not.toMatch(/key\s*===\s*"s"/i);
    }
  });
});

/**
 * ANT-76. A release found in the background has to be visible without
 * opening anything, and the app menu is where macOS apps keep it: right
 * under About, labelled with what updating is waiting on.
 */
describe("updates in the app menu", () => {
  const appMenu = main.slice(main.indexOf('role: "appMenu"'), main.indexOf('label: "File"'));

  it("sits under About and takes its label from where updating stands", () => {
    expect(appMenu.indexOf('{ role: "about" }')).toBeLessThan(appMenu.indexOf('id: "check-for-updates"'));
    expect(appMenu).toContain("label: update.label");
    expect(main).toContain("const update = updateMenuItem(updates().status());");
  });

  it("is rebuilt whenever that changes", () => {
    const setup = main.slice(main.indexOf("function updates(): UpdateController"));
    const onChange = setup.slice(setup.indexOf("onChange: (status) => {"), setup.indexOf("\n  return updateController;"));
    expect(onChange).toContain("UPDATE_STATUS_CHANNEL");
    expect(onChange).toContain("applyMenu();");
  });

  it("asks before restarting, from the menu as from Settings", () => {
    expect(appMenu).toContain("void installUpdate();");
    expect(main).toContain("guard: mayRestartToUpdate,");
  });
});
