/**
 * The two ways Save used to write somewhere nobody asked for.
 *
 * A person deleted a workflow's file outside Anthill, renamed the workflow,
 * and pressed Save. Anthill recreated the file at the old path under the old
 * name and said nothing (ANT-57) — it discarded both the deletion and the
 * rename in one click.
 */

import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { nameInSavedFile, saveDestination, suggestedPath } from "./save-destination.js";

const FOLDER = join("/Users", "someone", "Workflows");
const PATH = join(FOLDER, "Old Name.workflow.json");

describe("where a save goes", () => {
  it("asks when the workflow has never been saved", () => {
    expect(saveDestination("Fresh", undefined, { kind: "missing" })).toEqual({
      kind: "ask",
      suggested: "Fresh.workflow.json",
    });
  });

  it("writes where it wrote before when nothing has changed", () => {
    expect(saveDestination("Old Name", PATH, { kind: "named", name: "Old Name" })).toEqual({
      kind: "write",
      path: PATH,
    });
  });

  it("asks when the saved file has been deleted underneath it", () => {
    expect(saveDestination("Old Name", PATH, { kind: "missing" })).toEqual({
      kind: "ask",
      suggested: join(FOLDER, "Old Name.workflow.json"),
    });
  });

  it("asks when the workflow has been renamed since it was written", () => {
    expect(saveDestination("New Name", PATH, { kind: "named", name: "Old Name" })).toEqual({
      kind: "ask",
      suggested: join(FOLDER, "New Name.workflow.json"),
    });
  });

  /** The reported sequence: deleted outside Anthill, then renamed, then Save. */
  it("asks for the renamed file when the old one is gone as well", () => {
    expect(saveDestination("New Name", PATH, { kind: "missing" })).toEqual({
      kind: "ask",
      suggested: join(FOLDER, "New Name.workflow.json"),
    });
  });

  /** Only a positive reason earns a question. A broken file is not one. */
  it("writes when the file is there but says nothing about its name", () => {
    expect(saveDestination("New Name", PATH, { kind: "unreadable" })).toEqual({
      kind: "write",
      path: PATH,
    });
  });

  it("ignores whitespace either side of a name", () => {
    expect(saveDestination("  Old Name ", PATH, { kind: "named", name: "Old Name" })).toEqual({
      kind: "write",
      path: PATH,
    });
  });
});

describe("the name offered in the dialog", () => {
  it("keeps the suffix the app saves under", () => {
    expect(suggestedPath("Anything")).toBe("Anything.workflow.json");
  });

  it("offers it beside the file it replaces, not somewhere new", () => {
    expect(dirname(suggestedPath("New Name", PATH))).toBe(FOLDER);
  });

  it("flattens anything that would turn a name into a path", () => {
    expect(suggestedPath("reports/2026: draft?")).toBe("reports 2026 draft.workflow.json");
  });

  it("never offers a hidden or empty filename", () => {
    expect(suggestedPath("...")).toBe("workflow.workflow.json");
    expect(suggestedPath("   ")).toBe("workflow.workflow.json");
  });

  it("opens a first save in the workflow folder, and a later one where it already lives", () => {
    expect(saveDestination("Fresh", undefined, { kind: "missing" }, "/Users/me/flows")).toEqual({
      kind: "ask",
      suggested: "/Users/me/flows/Fresh.workflow.json",
    });
    // The folder never moves a workflow that has a home already.
    expect(dirname(suggestedPath("Renamed", PATH, "/Users/me/flows"))).toBe(FOLDER);
  });
});

describe("reading the name out of a saved file", () => {
  it("finds the name a workflow file records", () => {
    expect(nameInSavedFile(JSON.stringify({ name: "Old Name", nodes: [] }))).toBe("Old Name");
  });

  it("treats unreadable contents as no evidence rather than an error", () => {
    expect(nameInSavedFile("{ truncated")).toBeUndefined();
    expect(nameInSavedFile("null")).toBeUndefined();
    expect(nameInSavedFile(JSON.stringify({ nodes: [] }))).toBeUndefined();
    expect(nameInSavedFile(JSON.stringify({ name: 7 }))).toBeUndefined();
  });
});

/* ANT-177: a save nobody is asked about never overwrites a file. */
describe("a free path for a save made without asking", () => {
  it("keeps the suggested name when nothing is there", async () => {
    const { freePath } = await import("./save-destination.js");
    expect(freePath("/w/Fix bug.workflow.json", () => false)).toBe("/w/Fix bug.workflow.json");
  });

  it("numbers the name past every file already there", async () => {
    const { freePath } = await import("./save-destination.js");
    const taken = new Set(["/w/Fix bug.workflow.json", "/w/Fix bug 2.workflow.json"]);
    expect(freePath("/w/Fix bug.workflow.json", (path) => taken.has(path))).toBe("/w/Fix bug 3.workflow.json");
  });
});
