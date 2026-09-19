/**
 * The words the app and the MCP server both use about a revision's state.
 *
 * What matters is that every combination has an answer and that the two
 * handover modes are told apart: under a gate a draft is something the harness
 * is waiting on, and under show-and-go the same draft is something it may
 * already be working from.
 */

import { describe, expect, it } from "vitest";

import { HANDOVER_MODES, type RevisionState } from "./contracts.js";
import { describeState } from "./state.js";

const STATES: RevisionState[] = ["draft", "ready_for_agent", "bound"];

describe("describeState", () => {
  it("has something to say about every state in every mode", () => {
    for (const state of STATES) {
      for (const mode of HANDOVER_MODES) {
        const described = describeState(state, mode);
        expect(described.label.trim(), `${state}/${mode}`).toBeTruthy();
        expect(described.detail.trim(), `${state}/${mode}`).toBeTruthy();
        // A label belongs on a badge; a sentence does not fit on one.
        expect(described.label.length, `${state}/${mode}`).toBeLessThan(20);
      }
    }
  });

  it("says a draft under a gate is waiting on the user, and one without a gate is not", () => {
    expect(describeState("draft", "approval-gate").detail).toContain("waiting for your approval");
    expect(describeState("draft", "approval-gate").detail).toContain("external session activity is separate");
    expect(describeState("draft", "approval-gate").next).toContain("mark it ready");

    expect(describeState("draft", "show-and-go").detail).toContain("may begin");
    expect(describeState("draft", "show-and-go").next).not.toContain("mark it ready");
  });

  it("distinguishes an approved revision from one that merely validates", () => {
    expect(describeState("ready_for_agent", "approval-gate").label).toBe("Approved");
    expect(describeState("ready_for_agent", "show-and-go").label).toBe("Ready");
  });

  it("says a bound revision is frozen, whichever mode it arrived under", () => {
    for (const mode of HANDOVER_MODES) {
      const described = describeState("bound", mode);
      expect(described.label).toBe("Bound to run");
      expect(described.detail).toContain("not evidence");
      expect(described.next).toContain("cannot change");
      expect(described.next).toContain("new one");
    }
  });
});
