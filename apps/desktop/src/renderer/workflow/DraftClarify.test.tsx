/**
 * The Draft screen: one open question at a time.
 *
 * ANT-43. This screen exists for what the interpreter could not settle and for
 * nothing else. The rules worth pinning are the ones that make it a decision
 * rather than a reading task: one question on screen, the draft never shown, a
 * quick pick that answers and advances, and typing that does not.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftQuestion, WorkflowDraft } from "@anthill/workflow";

import { DraftClarify, questionLocator } from "./DraftClarify.js";

function question(over: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    id: "q1",
    question: "Which browsers must this support?",
    why: "It decides whether the work includes a compatibility pass.",
    about: { kind: "brief", field: "goal" },
    options: ["Modern evergreen only", "Include Safari 15"],
    ...over,
  };
}

function draft(questions: DraftQuestion[]): WorkflowDraft {
  return {
    draftVersion: 1,
    title: "Rework the checkout",
    brief: { goal: "Make checkout survive a failed payment." },
    agents: [{ id: "dev", name: "Developer" }],
    steps: [
      { id: "s1", name: "Scaffold the flow", kind: "step", agent: "dev" },
      { id: "s2", name: "Attack the design", kind: "step", agent: "dev" },
    ],
    questions,
  } as WorkflowDraft;
}

function show(questions: DraftQuestion[]) {
  const onOpen = vi.fn();
  const onBack = vi.fn();
  render(
    <DraftClarify
      draft={draft(questions)}
      interpreterLabel="Claude Code"
      onBack={onBack}
      onOpen={onOpen}
    />,
  );
  return { onOpen, onBack };
}

const field = () => screen.getByLabelText("Answer in your own words") as HTMLInputElement;
const advance = () => screen.getByRole("button", { name: /^(Next|Done)$/ }) as HTMLButtonElement;

afterEach(cleanup);

describe("what the screen shows", () => {
  it("shows one question, and not the others", () => {
    show([question(), question({ id: "q2", question: "Should it retry automatically?" })]);
    expect(screen.getByText("Which browsers must this support?")).toBeTruthy();
    expect(screen.queryByText("Should it retry automatically?")).toBeNull();
  });

  it("never dumps the draft – no brief, no agents, no step list", () => {
    show([question()]);
    // The things the previous design put on screen and this one deliberately does not.
    expect(screen.queryByText(/Make checkout survive/)).toBeNull();
    expect(screen.queryByText("Developer")).toBeNull();
    expect(screen.queryByText("Scaffold the flow")).toBeNull();
    expect(screen.queryByText("Attack the design")).toBeNull();
  });

  it("says where in the draft the question came from", () => {
    // This is what earns the right not to show the draft.
    show([question()]);
    expect(screen.getByText("Goal")).toBeTruthy();
  });

  it("counts in words, and agrees with itself for a single question", () => {
    show([question()]);
    expect(screen.getByText("one thing")).toBeTruthy();
    expect(screen.getByText("Question 1 of 1")).toBeTruthy();
  });

  it("counts two as two", () => {
    show([question(), question({ id: "q2" })]);
    expect(screen.getByText("two things")).toBeTruthy();
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
  });

  it("falls back to its own sentence when the interpreter gave no reason", () => {
    show([question({ why: undefined })]);
    expect(screen.getByText(/Claude Code could not tell from the prompt/)).toBeTruthy();
  });

  it("shows nothing red", () => {
    // A question is not a problem. Validation errors are red and wait on the canvas.
    show([question()]);
    expect(document.querySelector(".error, .is-destructive, .chip.error")).toBeNull();
  });
});

describe("answering", () => {
  it("advances on a quick pick, in one press", () => {
    show([question(), question({ id: "q2", question: "Should it retry automatically?" })]);
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    expect(screen.getByText("Should it retry automatically?")).toBeTruthy();
    expect(screen.getByText("Question 2 of 2")).toBeTruthy();
  });

  it("does not advance on typing alone", () => {
    show([question(), question({ id: "q2", question: "Should it retry automatically?" })]);
    fireEvent.change(field(), { target: { value: "Only Chrome" } });
    // Still the first question: a half-typed answer must never be submitted.
    expect(screen.getByText("Which browsers must this support?")).toBeTruthy();
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
  });

  it("commits on Enter", () => {
    show([question(), question({ id: "q2", question: "Should it retry automatically?" })]);
    fireEvent.change(field(), { target: { value: "Only Chrome" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByText("Should it retry automatically?")).toBeTruthy();
  });

  it("commits on the button", () => {
    show([question(), question({ id: "q2", question: "Should it retry automatically?" })]);
    fireEvent.change(field(), { target: { value: "Only Chrome" } });
    fireEvent.click(advance());
    expect(screen.getByText("Should it retry automatically?")).toBeTruthy();
  });

  it("disables the button while the field is empty", () => {
    show([question()]);
    expect(advance().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "Only Chrome" } });
    expect(advance().disabled).toBe(false);
  });

  it("refuses whitespace as an answer", () => {
    show([question()]);
    fireEvent.change(field(), { target: { value: "   " } });
    expect(advance().disabled).toBe(true);
  });

  it("reads Next until the last question, then Done", () => {
    show([question(), question({ id: "q2" })]);
    expect(advance().textContent).toBe("Next");
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    expect(advance().textContent).toBe("Done");
  });

  it("clears the field between questions", () => {
    show([question(), question({ id: "q2" })]);
    fireEvent.change(field(), { target: { value: "Only Chrome" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("");
  });
});

describe("when the queue is empty", () => {
  const answerBoth = () => {
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
  };

  it("replaces the card rather than stacking under it", () => {
    show([question(), question({ id: "q2" })]);
    answerBoth();
    expect(screen.getByLabelText("All answered")).toBeTruthy();
    expect(screen.queryByLabelText("Open question")).toBeNull();
  });

  it("says what actually happens to the answers", () => {
    // The copy must not claim a round trip the code does not make.
    show([question(), question({ id: "q2" })]);
    answerBoth();
    expect(screen.getByText(/Nothing is sent back to Claude Code/)).toBeTruthy();
  });

  it("hands every answer over on Open", () => {
    const { onOpen } = show([question(), question({ id: "q2" })]);
    answerBoth();
    fireEvent.click(screen.getByRole("button", { name: "Open the workflow" }));
    expect(onOpen).toHaveBeenCalledWith({ q1: "Include Safari 15", q2: "Include Safari 15" });
  });

  it("drops the skip link and the dots once there is nothing left to skip", () => {
    show([question()]);
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
    expect(document.querySelector(".clarify-dots")).toBeNull();
  });

  it("says all answered in the progress pill", () => {
    show([question()]);
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    expect(screen.getByText("All answered")).toBeTruthy();
  });
});

describe("skipping", () => {
  it("is offered from the first question", () => {
    show([question()]);
    expect(screen.getByRole("button", { name: /^Skip/ })).toBeTruthy();
  });

  it("says what it leaves behind", () => {
    show([question()]);
    expect(
      screen.getByText(/unanswered questions stay with the workflow/),
    ).toBeTruthy();
  });

  it("carries the answers already given, and no more", () => {
    const { onOpen } = show([question(), question({ id: "q2" })]);
    fireEvent.click(screen.getByRole("button", { name: "Include Safari 15" }));
    fireEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    expect(onOpen).toHaveBeenCalledWith({ q1: "Include Safari 15" });
  });
});

describe("the locator", () => {
  const d = draft([]);

  it("names a brief field the way the brief does", () => {
    expect(questionLocator(question({ about: { kind: "brief", field: "doneCriteria" } }), d)).toBe(
      "Done criteria",
    );
  });

  it("falls back to the raw field name for one it does not know", () => {
    expect(questionLocator(question({ about: { kind: "brief", field: "vibes" } }), d)).toBe("vibes");
  });

  it("numbers a step and names it", () => {
    expect(questionLocator(question({ about: { kind: "step", stepId: "s2" } }), d)).toBe(
      "Step 2 · Attack the design",
    );
  });

  it("names the handover an output question is about", () => {
    expect(
      questionLocator(question({ about: { kind: "output", stepId: "s1", outputTo: "s2" } }), d),
    ).toBe("Step 1 · Scaffold the flow → s2");
  });

  it("says so plainly for a question about the whole workflow", () => {
    expect(questionLocator(question({ about: { kind: "workflow" } }), d)).toBe("The workflow");
  });

  it("does not invent a number for a step that is not in the draft", () => {
    expect(questionLocator(question({ about: { kind: "step", stepId: "gone" } }), d)).toBe("A step");
  });
});
