/**
 * The layout, and the one rule that keeps it a layout rather than an opening.
 *
 * Every id that becomes a path segment here arrived over MCP from a process
 * Anthill did not start. The cases worth holding onto are the ones an attacker
 * would try and a careless harness would produce by accident: separators,
 * traversal, and a name made entirely of characters that cannot be in one.
 */

import { describe, expect, it } from "vitest";

import {
  exchangeRoot,
  identityPath,
  inboxPath,
  keyFromInboxFileName,
  revisionFromFileName,
  revisionFromReadyFileName,
  revisionPath,
  revisionStem,
  safeSegment,
  workflowDir,
  workingCopyPath,
} from "./paths.js";

const ROOT = exchangeRoot("/tmp/anthill");

describe("safeSegment", () => {
  it("keeps the characters an id is normally made of", () => {
    expect(safeSegment("workflow-1_v2", "fallback")).toBe("workflow-1_v2");
  });

  it("has an answer for an id there is nothing left of", () => {
    expect(safeSegment("", "fallback")).toBe("fallback");
  });

  it("leaves no way to write a segment that is a dot or two", () => {
    // Dots go the way of separators rather than being kept, so "." and ".."
    // both become an ordinary name. That two ids can land on the same name is
    // not a hole: the identity record says which one got there, and the second
    // is reported as a conflict rather than merged into the first.
    expect(safeSegment(".", "fallback")).toBe("_");
    expect(safeSegment("..", "fallback")).toBe("_");
    expect(safeSegment("../..", "fallback")).toBe("_");
  });

  it("is idempotent, so a name read back from a listing addresses the same file", () => {
    const once = safeSegment("a/b:c", "fallback");
    expect(safeSegment(once, "fallback")).toBe(once);
  });
});

describe("path escape", () => {
  it("keeps a traversing workflow id under the root", () => {
    for (const id of ["../../../etc/passwd", "..", "/absolute", "a/../../b", "~"]) {
      for (const path of [
        workflowDir(ROOT, id),
        identityPath(ROOT, id),
        workingCopyPath(ROOT, id),
        revisionPath(ROOT, id, 1),
      ]) {
        expect(path.startsWith(`${ROOT}/`), `${id} → ${path}`).toBe(true);
        expect(path.includes(".."), `${id} → ${path}`).toBe(false);
      }
    }
  });

  it("keeps a traversing inbox key under the inbox", () => {
    expect(inboxPath(ROOT, "../../evil")).toBe(`${ROOT}/inbox/_evil.json`);
  });
});

describe("revision file names", () => {
  it("pads so an alphabetical listing is already in order", () => {
    expect([9, 10, 100].map(revisionStem)).toEqual(["0009", "0010", "0100"]);
    expect(["0009", "0010", "0100"].slice().sort()).toEqual(["0009", "0010", "0100"]);
  });

  it("reads back a number it wrote", () => {
    expect(revisionFromFileName("0042.json")).toBe(42);
    expect(revisionFromReadyFileName("0042.ready")).toBe(42);
  });

  it("refuses anything that is not a revision", () => {
    // The atomic-write pattern used elsewhere in Anthill leaves these lying
    // beside their targets, and one read as a revision would be half a record.
    expect(revisionFromFileName("0042.json.4242.1.tmp")).toBeUndefined();
    expect(revisionFromFileName("0042.ready")).toBeUndefined();
    expect(revisionFromFileName("latest.json")).toBeUndefined();
    expect(revisionFromFileName("0000.json")).toBeUndefined();
  });
});

describe("inbox file names", () => {
  it("takes a drop and nothing else", () => {
    expect(keyFromInboxFileName("drop-1.json")).toBe("drop-1");
    expect(keyFromInboxFileName("drop-1.json.4242.1.tmp")).toBeUndefined();
    expect(keyFromInboxFileName("done")).toBeUndefined();
    expect(keyFromInboxFileName(".DS_Store")).toBeUndefined();
  });
});
