/**
 * Stepping back and forward, as a thing with no React in it.
 *
 * ANT-38. The properties worth pinning are the ones a hand-rolled undo tends
 * to get wrong: that stepping back and forward round-trips exactly, that a new
 * edit after stepping back abandons the branch rather than leaving a Redo that
 * would jump somewhere unrelated, and that a long session forgets its oldest
 * steps instead of growing without end.
 */

import { describe, expect, it } from "vitest";

import {
  COALESCE_MS,
  HISTORY_LIMIT,
  canStepBack,
  canStepForward,
  emptyHistory,
  recordEdit,
  stepBack,
  stepForward,
  type History,
} from "./workflow-history.js";

/**
 * Numbers stand in for workflows: the module never looks inside the state.
 * Each edit is a second apart, so these are separate decisions rather than one
 * gesture — coalescing has its own tests below.
 */
function after(...edits: number[]): { history: History<number>; current: number } {
  let history = emptyHistory<number>();
  let current = 0;
  let clock = 0;
  for (const next of edits) {
    clock += 1000;
    history = recordEdit(history, current, clock);
    current = next;
  }
  return { history, current };
}

describe("stepping back and forward", () => {
  it("has nowhere to go before anything has happened", () => {
    const history = emptyHistory<number>();
    expect(canStepBack(history)).toBe(false);
    expect(canStepForward(history)).toBe(false);
    expect(stepBack(history, 0)).toBeUndefined();
    expect(stepForward(history, 0)).toBeUndefined();
  });

  it("goes back one edit at a time", () => {
    const { history, current } = after(1, 2, 3);
    const first = stepBack(history, current);
    expect(first?.state).toBe(2);
    const second = stepBack(first!.history, first!.state);
    expect(second?.state).toBe(1);
    const third = stepBack(second!.history, second!.state);
    expect(third?.state).toBe(0);
    expect(canStepBack(third!.history)).toBe(false);
  });

  it("round-trips exactly", () => {
    const { history, current } = after(1, 2, 3);
    const back = stepBack(history, current)!;
    const forward = stepForward(back.history, back.state)!;
    expect(forward.state).toBe(current);
    expect(forward.history.past).toEqual(history.past);
    expect(forward.history.future).toEqual(history.future);
  });

  it("abandons the branch when an edit follows a step back", () => {
    // Redo pointing at a state the author has since diverged from would be a
    // button that jumps somewhere they never were.
    const { history, current } = after(1, 2, 3);
    const back = stepBack(history, current)!;
    expect(canStepForward(back.history)).toBe(true);

    const edited = recordEdit(back.history, back.state);
    expect(canStepForward(edited)).toBe(false);
    expect(canStepBack(edited)).toBe(true);
  });

  it("forgets its oldest steps rather than growing without end", () => {
    let history = emptyHistory<number>();
    for (let at = 0; at < HISTORY_LIMIT + 20; at += 1) {
      history = recordEdit(history, at, at * 1000);
    }
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    // The oldest went, the newest stayed.
    expect(history.past[0]).toBe(20);
    expect(history.past[HISTORY_LIMIT - 1]).toBe(HISTORY_LIMIT + 19);
  });

  it("caps stepping forward too, so a long round trip cannot outgrow the limit", () => {
    let history = emptyHistory<number>();
    for (let at = 0; at < HISTORY_LIMIT; at += 1) history = recordEdit(history, at, at * 1000);
    const back = stepBack(history, 999)!;
    const forward = stepForward(back.history, back.state)!;
    expect(forward.history.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });

  it("keeps states by value, so a later mutation cannot rewrite the past", () => {
    // Workflows are replaced rather than mutated everywhere in the app, and
    // this records references — the test states the assumption out loud.
    const one = { name: "first" };
    const two = { name: "second" };
    let history = emptyHistory<typeof one>();
    history = recordEdit(history, one, 1000);
    const back = stepBack(history, two)!;
    expect(back.state).toBe(one);
    expect(back.state.name).toBe("first");
  });
});

/**
 * One gesture, one step.
 *
 * Typing a name fires an edit per keystroke and dragging a block fires one per
 * frame. Recorded as they come, Step back walks a rename backwards one letter
 * at a time — a faithful history and a useless undo. Found by using it: 25
 * presses to take back one rename.
 */
describe("edits that are really one gesture", () => {
  it("collapses a burst into a single step", () => {
    let history = emptyHistory<string>();
    // "a" → "ab" → "abc", typed.
    history = recordEdit(history, "", 1000);
    history = recordEdit(history, "a", 1080);
    history = recordEdit(history, "ab", 1160);

    expect(history.past).toHaveLength(1);
    // And the one step lands before the gesture began.
    expect(stepBack(history, "abc")?.state).toBe("");
  });

  it("starts a new step once the author pauses", () => {
    let history = emptyHistory<string>();
    history = recordEdit(history, "", 1000);
    history = recordEdit(history, "a", 1080);
    history = recordEdit(history, "ab", 1080 + COALESCE_MS);

    expect(history.past).toHaveLength(2);
    expect(stepBack(history, "abc")?.state).toBe("ab");
  });

  it("does not merge an edit into a step that was just undone", () => {
    // Stepping back is not part of the gesture before it, so what comes next
    // is a new decision even if it lands immediately.
    let history = emptyHistory<string>();
    history = recordEdit(history, "one", 1000);
    const back = stepBack(history, "two")!;
    const edited = recordEdit(back.history, back.state, 1001);

    expect(edited.past).toHaveLength(1);
    expect(stepBack(edited, "three")?.state).toBe("one");
  });

  it("still clears the future when a burst continues", () => {
    let history = emptyHistory<string>();
    history = recordEdit(history, "one", 1000);
    const back = stepBack(history, "two")!;
    let edited = recordEdit(back.history, back.state, 5000);
    edited = recordEdit(edited, "three", 5050);
    expect(canStepForward(edited)).toBe(false);
  });
});
