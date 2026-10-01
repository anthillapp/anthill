import { describe, expect, it } from "vitest";

import { applyAnswers, needsClarification, openQuestions } from "./draft-answers.js";
import { WORKFLOWNER_DRAFT_VERSION, validateDraft, type WorkflowDraft } from "./draft.js";

function draft(questions: WorkflowDraft["questions"] = []): WorkflowDraft {
  return {
    draftVersion: WORKFLOWNER_DRAFT_VERSION,
    title: "Rate limit the public API",
    brief: { goal: "Public endpoints are rate limited.", doneCriteria: ["The suite passes."] },
    agents: [{ id: "dev", name: "Developer" }],
    steps: [
      {
        id: "implement",
        name: "Implement",
        kind: "step",
        agent: "dev",
        action: "agent-step",
        task: "Add the limiter.",
        outputs: [{ to: "end" }],
      },
    ],
    questions,
  };
}

const ask = (over: Partial<WorkflowDraft["questions"][number]> = {}) => ({
  id: "q1",
  question: "Which endpoints count as public?",
  about: { kind: "workflow" as const },
  options: [],
  ...over,
});

describe("where an answer lands", () => {
  it("refines the brief field it was asked about, without losing what was there", () => {
    const source = draft([ask({ about: { kind: "brief", field: "goal" } })]);
    const { draft: next } = applyAnswers(source, { q1: "Everything under /api/v1." });
    expect(next.brief.goal).toBe(
      "Public endpoints are rate limited. Everything under /api/v1.",
    );
  });

  it("adds to a list field rather than overwriting it", () => {
    const source = draft([ask({ about: { kind: "brief", field: "doneCriteria" } })]);
    const { draft: next } = applyAnswers(source, { q1: "The limiter is covered by tests." });
    expect(next.brief.doneCriteria).toEqual([
      "The suite passes.",
      "The limiter is covered by tests.",
    ]);
  });

  it("does not add the same list answer twice", () => {
    // The author may answer, go back, and answer again.
    const source = draft([ask({ about: { kind: "brief", field: "constraints" } })]);
    const once = applyAnswers(source, { q1: "Keep it in one file." }).draft;
    const twice = applyAnswers(once, { q1: "Keep it in one file." }).draft;
    expect(twice.brief.constraints).toEqual(["Keep it in one file."]);
  });

  it("puts a step's answer in that step's task, on its own line, with its question", () => {
    const source = draft([ask({ about: { kind: "step", stepId: "implement" } })]);
    const { draft: next } = applyAnswers(source, { q1: "Count per API key." });
    expect(next.steps[0].task).toBe(
      "Add the limiter.\nWhich endpoints count as public? Answer: Count per API key.",
    );
  });

  /*
    ANT-219, W15 in the 0.8.5 QA. The picked option was written into the
    Reviewer's task on its own, as an order to reject every summary.
  */
  it("keeps the condition a question carries", () => {
    const source = draft([
      ask({
        question: "If the Reviewer still requests changes after the second Reporter attempt, how should the workflow end?",
        about: { kind: "step", stepId: "implement" },
        options: ["End and report the result as not approved"],
      }),
    ]);
    const { draft: next } = applyAnswers(source, { q1: "End and report the result as not approved" });
    const added = next.steps[0].task?.split("\n")[1] ?? "";
    expect(added.startsWith("If the Reviewer still requests changes after the second Reporter attempt")).toBe(true);
    expect(added).toContain("Answer: End and report the result as not approved");
  });

  it("puts an output's answer with its step, which is where the work is", () => {
    const source = draft([
      ask({ about: { kind: "output", stepId: "implement", outputTo: "end" } }),
    ]);
    const { draft: next } = applyAnswers(source, { q1: "Retry twice, then stop." });
    expect(next.steps[0].task).toContain("Retry twice, then stop.");
  });

  it("makes a workflow-level answer part of the shared context", () => {
    const { draft: next } = applyAnswers(draft([ask()]), { q1: "It ships behind a flag." });
    expect(next.brief.context).toBe("Which endpoints count as public? Answer: It ships behind a flag.");
  });

  it("ignores an answer to a step that is not in the draft", () => {
    const source = draft([ask({ about: { kind: "step", stepId: "gone" } })]);
    const { draft: next } = applyAnswers(source, { q1: "Anything." });
    expect(next.steps[0].task).toBe("Add the limiter.");
  });

  it("ignores a brief field it does not have", () => {
    const source = draft([ask({ about: { kind: "brief", field: "invented" } })]);
    expect(applyAnswers(source, { q1: "x" }).draft.brief).toEqual(source.brief);
  });
});

describe("recording what was said", () => {
  it("keeps the answer on the question", () => {
    const { draft: next } = applyAnswers(draft([ask()]), { q1: "Under /api/v1." });
    expect(next.questions[0].answer).toBe("Under /api/v1.");
  });

  it("counts what it actually used", () => {
    const source = draft([ask(), ask({ id: "q2", question: "And the rate?" })]);
    expect(applyAnswers(source, { q1: "a", q2: "b" }).applied).toBe(2);
    expect(applyAnswers(source, { q1: "a" }).applied).toBe(1);
  });

  it("treats a blank answer as no answer at all", () => {
    const { draft: next, applied } = applyAnswers(draft([ask()]), { q1: "   " });
    expect(applied).toBe(0);
    expect(next.questions[0].answer).toBeUndefined();
    expect(next.brief.context).toBeUndefined();
  });

  it("leaves a draft with no answers exactly as it was", () => {
    const source = draft([ask()]);
    expect(applyAnswers(source, {}).draft).toEqual(source);
  });
});

describe("what is still open", () => {
  it("lists the questions with nothing against them", () => {
    const source = draft([ask(), ask({ id: "q2", question: "And the rate?" })]);
    expect(openQuestions(source, { q1: "answered" }).map((q) => q.id)).toEqual(["q2"]);
  });

  it("counts an answer already on the question as answered", () => {
    const source = draft([ask({ answer: "settled earlier" })]);
    expect(openQuestions(source)).toEqual([]);
  });

  it("decides whether the author is needed before the workflow opens", () => {
    // A draft with nothing open must not make them confirm a screen they have
    // no input on.
    expect(needsClarification(draft([]))).toBe(false);
    expect(needsClarification(draft([ask()]))).toBe(true);
    expect(needsClarification(draft([ask({ answer: "done" })]))).toBe(false);
  });
});

describe("reading questions off an interpreter's reply", () => {
  const parse = (questions: unknown, extra: Record<string, unknown> = {}) => {
    const result = validateDraft({
      draftVersion: WORKFLOWNER_DRAFT_VERSION,
      title: "t",
      agents: [],
      steps: [{ id: "a", name: "A", kind: "step", task: "x", action: "agent-step" }],
      questions,
      ...extra,
    });
    return result.ok ? result.draft.questions : [];
  };

  it("reads a located question with its alternatives", () => {
    expect(
      parse([
        {
          id: "scope",
          question: "Which endpoints count as public?",
          why: "It decides what the limiter wraps.",
          about: { kind: "brief", field: "goal" },
          options: ["Everything under /api", "Only v1"],
        },
      ]),
    ).toEqual([
      {
        id: "scope",
        question: "Which endpoints count as public?",
        why: "It decides what the limiter wraps.",
        about: { kind: "brief", field: "goal" },
        options: ["Everything under /api", "Only v1"],
      },
    ]);
  });

  it("falls back to workflow level for a locator it does not recognise", () => {
    // Better shown at the top than dropped for naming the wrong thing.
    expect(parse([{ question: "q", about: { kind: "elsewhere" } }])[0].about).toEqual({
      kind: "workflow",
    });
  });

  it("falls back to workflow level when a locator is missing its target", () => {
    expect(parse([{ question: "q", about: { kind: "step" } }])[0].about).toEqual({
      kind: "workflow",
    });
  });

  it("still reads the older two-list shape, so a stale draft opens", () => {
    const questions = parse(["Is it per key?"], { uncertainties: ["The rate is not stated."] });
    expect(questions.map((item) => item.question)).toEqual([
      "Is it per key?",
      "The rate is not stated.",
    ]);
    expect(questions.every((item) => item.options.length === 0)).toBe(true);
  });

  it("gives every question an id, so an answer has something to file against", () => {
    const questions = parse([{ question: "a" }, { question: "b" }]);
    expect(new Set(questions.map((item) => item.id)).size).toBe(2);
  });

  it("does not let two questions share an id", () => {
    const questions = parse([
      { id: "same", question: "a" },
      { id: "same", question: "b" },
    ]);
    expect(questions[0].id).not.toBe(questions[1].id);
  });

  it("skips an entry with no question in it", () => {
    expect(parse([{ why: "no question here" }, "  "])).toEqual([]);
  });

  it("reports no questions as an empty list, not a missing one", () => {
    expect(parse(undefined)).toEqual([]);
  });
});
