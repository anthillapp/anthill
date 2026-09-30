/**
 * Folding the author's answers back into a draft.
 *
 * The alternative was sending the answers back to the interpreter for a second
 * pass. That costs another minute of waiting to have a model reword text the
 * author has just written themselves, and it is free to rewrite the parts they
 * did not ask it to touch. Applying the answers here is instant, and what the
 * author typed is what ends up in the workflow.
 *
 * An answer goes where its question was asked: a question about the goal
 * refines the goal, a question about a step lands in that step's task. So the
 * generated prompt carries the answer in the place it is needed, rather than in
 * a footnote nobody reads. Every answer is also recorded on its question, so
 * months later the workflow can still say what was asked and what came back.
 */

import type { WorkflowBrief } from "@anthill/workflow-schema";

import type { DraftQuestion, WorkflowDraft } from "./draft.js";

/** Brief fields that hold one piece of prose. */
const PROSE_FIELDS = ["goal", "context", "verification", "finalAction"] as const;
/** Brief fields that hold a list of items. */
const LIST_FIELDS = [
  "assumptions",
  "doneCriteria",
  "constraints",
  "prohibitedActions",
  "report",
] as const;

type ProseField = (typeof PROSE_FIELDS)[number];
type ListField = (typeof LIST_FIELDS)[number];

const isProseField = (field: string): field is ProseField =>
  (PROSE_FIELDS as readonly string[]).includes(field);
const isListField = (field: string): field is ListField =>
  (LIST_FIELDS as readonly string[]).includes(field);

/**
 * An answer, with the question it answers.
 *
 * An answer alone is often half a sentence. "End and report the result as not
 * approved", picked for "If the Reviewer still requests changes after the
 * second attempt, how should the workflow end?", landed in the Reviewer's task
 * as an unconditional order — reject everything — and contradicted the rest of
 * it (ANT-219). The question carries the condition, so it goes with the answer.
 * A brief field needs none of this: its question is what the field is.
 */
function answered(question: DraftQuestion, answer: string): string {
  const asked = clean(question.question);
  return asked ? `${asked} Answer: ${answer}` : answer;
}

/** Answers keyed by question id, as the clarification screen collects them. */
export type DraftAnswers = Record<string, string>;

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Add a sentence to a piece of prose without gluing it to the last one.
 *
 * Existing text is kept: an answer clarifies what was drafted, it does not
 * replace it, and quietly dropping a goal the author may have already edited
 * would be the wrong kind of helpful.
 */
function extend(existing: string | undefined, addition: string): string {
  const before = clean(existing);
  if (!before) return addition;
  return `${before.replace(/\s*$/, "")} ${addition}`;
}

function applyToBrief(brief: WorkflowBrief, field: string, answer: string): WorkflowBrief {
  if (isProseField(field)) {
    return { ...brief, [field]: extend(brief[field], answer) };
  }
  if (isListField(field)) {
    const existing = brief[field] ?? [];
    // A repeated answer must not accumulate: the author may answer, go back,
    // and answer again.
    return existing.includes(answer)
      ? brief
      : { ...brief, [field]: [...existing, answer] };
  }
  return brief;
}

export type ApplyAnswersResult = {
  draft: WorkflowDraft;
  /** How many answers were actually used. */
  applied: number;
};

/**
 * Apply what the author said to the draft it was asked about.
 *
 * Blank answers are skipped rather than written as empty text, so leaving a
 * question alone and answering it with whitespace come to the same thing.
 */
export function applyAnswers(draft: WorkflowDraft, answers: DraftAnswers): ApplyAnswersResult {
  let brief: WorkflowBrief = { ...draft.brief };
  const taskAdditions = new Map<string, string[]>();
  const workflowLevel: string[] = [];
  let applied = 0;

  const questions: DraftQuestion[] = draft.questions.map((question) => {
    const answer = clean(answers[question.id]);
    if (!answer) return question;
    applied += 1;

    switch (question.about.kind) {
      case "brief":
        brief = applyToBrief(brief, question.about.field, answer);
        break;
      case "step":
      case "output": {
        const stepId = question.about.stepId;
        taskAdditions.set(stepId, [...(taskAdditions.get(stepId) ?? []), answered(question, answer)]);
        break;
      }
      default:
        // Nowhere narrower to put it, so it becomes context for the whole workflow.
        workflowLevel.push(answered(question, answer));
    }

    return { ...question, answer };
  });

  if (workflowLevel.length > 0) {
    brief = { ...brief, context: extend(brief.context, workflowLevel.join(" ")) };
  }

  const steps = draft.steps.map((step) => {
    const additions = taskAdditions.get(step.id);
    if (!additions) return step;
    // On its own line: an answer is a separate instruction, not a continuation
    // of the sentence the task ended on.
    return { ...step, task: [clean(step.task), ...additions].filter(Boolean).join("\n") };
  });

  return { draft: { ...draft, brief, steps, questions }, applied };
}

/** Questions still waiting on an answer. */
export function openQuestions(draft: WorkflowDraft, answers: DraftAnswers = {}): DraftQuestion[] {
  return draft.questions.filter(
    (question) => !clean(answers[question.id]) && !clean(question.answer),
  );
}

/**
 * Whether a draft needs the author before the workflow opens.
 *
 * A draft with nothing open must not make them confirm a screen they have no
 * input on, so this is what decides whether the clarification step happens.
 */
export function needsClarification(draft: WorkflowDraft): boolean {
  return openQuestions(draft).length > 0;
}
