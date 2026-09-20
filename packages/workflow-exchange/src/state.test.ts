/**
 * The words the app and the MCP server both use about a revision's state.
 *
 * What matters is that every state has an answer, and that none of the answers
 * is about permission: these were written twice over per handover mode until
 * the approval gate was removed.
 */

import { describe, expect, it } from "vitest";

import type { RevisionState } from "./contracts.js";
import { describeState } from "./state.js";

const STATES: RevisionState[] = ["draft", "ready_for_agent", "bound"];

describe("describeState", () => {
  it("has something to say about every state", () => {
    for (const state of STATES) {
      const described = describeState(state);
      expect(described.label.trim(), state).toBeTruthy();
      expect(described.detail.trim(), state).toBeTruthy();
      // A label belongs on a badge; a sentence does not fit on one.
      expect(described.label.length, state).toBeLessThan(20);
    }
  });

  it("says a draft may be worked on as soon as it is complete", () => {
    expect(describeState("draft").detail).toContain("may begin");
    expect(describeState("draft").detail).toContain("as soon as it is complete");
  });

  /**
   * The one thing these words must not do.
   *
   * Every state here describes the graph or the run. None of them may ask the
   * user for permission or claim Anthill is withholding anything — it never
   * was, and saying so is what the gate's removal was about.
   */
  it("never asks the user to authorise anything", () => {
    for (const state of STATES) {
      const described = describeState(state);
      const prose = `${described.label} ${described.detail} ${described.next ?? ""}`.toLowerCase();
      for (const word of ["approve", "approval", "mark it ready", "authoris", "authoriz", "waiting for your"]) {
        expect(prose, `${state} says "${word}"`).not.toContain(word);
      }
    }
  });

  it("says a bound revision is frozen", () => {
    const described = describeState("bound");
    expect(described.label).toBe("Bound to run");
    expect(described.detail).toContain("not evidence");
    expect(described.next).toContain("cannot change");
    expect(described.next).toContain("new one");
  });
});
