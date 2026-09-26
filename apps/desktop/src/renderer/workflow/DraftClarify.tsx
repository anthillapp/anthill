/**
 * What the interpreter could not settle — one question at a time.
 *
 * This screen exists for that and nothing else. It is not a draft review, not
 * an approval gate, and not a summary of the generated workflow. A draft with
 * nothing open never reaches it: `PromptToWorkflowSheet` opens straight onto
 * the canvas, because a confirmation step the reader cannot act on is a toll,
 * and it teaches them to click through the one that does matter.
 *
 * It used to render the whole draft — brief, agents, every step — with each
 * question hung inside the part it belonged to. The reasoning was that a
 * question needs its context. What it actually produced was a reading task
 * where there is a decision to make, with two questions buried in a page of
 * things the reader had no input on. The locator line replaces all of that: it
 * says *where in the draft* the question comes from, which is the context the
 * reader needed, in eleven characters instead of a page.
 *
 * So: one question per screenful, the next replaces it, and when they are gone
 * the workflow opens.
 *
 * Answers are applied to the draft directly rather than sent back to the
 * interpreter for a second pass. That would cost another minute of waiting to
 * have a model reword text the author has just written, and leave it free to
 * rewrite what they did not ask it to touch. The done panel says what actually
 * happens, because copy that claims a round trip nobody makes is worse than no
 * copy at all.
 */

import { useMemo, useRef, useState } from "react";
import {
  openQuestions,
  type DraftAnswers,
  type DraftQuestion,
  type WorkflowDraft,
} from "@anthill/workflow";

import { AnthillMark } from "../AnthillMark.js";

export type DraftClarifyProps = {
  /**
   * The workflow this screen was opened over, when there is one. Every screen
   * with a workflow open names it beside the screen's own name, so the bar
   * always says both what you are looking at and what it is about.
   */
  workflowName?: string;
  draft: WorkflowDraft;
  interpreterLabel: string;
  onBack: () => void;
  onOpen: (answers: DraftAnswers) => void;
};

/** How a brief field is named, in the order the brief itself shows them. */
const BRIEF_LABELS: Record<string, string> = {
  goal: "Goal",
  context: "Project context",
  assumptions: "Assumptions",
  verification: "Verification",
  doneCriteria: "Done criteria",
  constraints: "Constraints",
  prohibitedActions: "Do not",
  finalAction: "Final action",
};

/** Numbers written out, because "two things" reads better than "2 things". */
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * Where in the draft a question comes from.
 *
 * This is what earns the right not to show the draft. "Step 2 · Attack the
 * design" tells the reader which part of their own request is in question
 * without putting the request back on screen.
 */
export function questionLocator(question: DraftQuestion, draft: WorkflowDraft): string {
  const about = question.about;
  if (about.kind === "brief") return BRIEF_LABELS[about.field] ?? about.field;
  if (about.kind === "workflow") return "The workflow";

  const index = draft.steps.findIndex((step) => step.id === about.stepId);
  const step = index >= 0 ? draft.steps[index] : undefined;
  const where = step ? `Step ${index + 1} · ${step.name}` : "A step";
  return about.kind === "output" ? `${where} → ${about.outputTo}` : where;
}

export function DraftClarify({
  draft,
  interpreterLabel,
  onBack,
  onOpen,
  workflowName,
}: DraftClarifyProps) {
  const [answers, setAnswers] = useState<DraftAnswers>({});
  /**
   * The queue is fixed when the screen opens.
   *
   * Recomputing it from `openQuestions(draft, answers)` would make the list
   * shrink under the reader as they answer — the count in the lede would fall,
   * the dots would vanish one by one, and going back to change an answer would
   * be impossible because the question would no longer be in the list.
   */
  const queue = useMemo(() => openQuestions(draft), [draft]);
  const [at, setAt] = useState(0);
  /** What is typed for the question on screen, before it is committed. */
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement | null>(null);

  const question = queue[at];
  const done = at >= queue.length;
  const last = at === queue.length - 1;

  const commit = (value: string) => {
    if (!question) return;
    const answer = value.trim();
    if (!answer) return;
    setAnswers((current) => ({ ...current, [question.id]: answer }));
    setTyped("");
    setAt((index) => index + 1);
  };

  return (
    <div className="app draft-clarify">
      <div className="subbar">
        <button className="icon-button" onClick={onBack} title="Back to the prompt">
          ←
        </button>
        <AnthillMark className="clarify-mark" size={18} />
        <span className="brand">Before the workflow opens</span>
        {workflowName ? <span className="screen-subject">{workflowName}</span> : null}
        <span className="spacer" />
        <span className="clarify-progress">
          <i aria-hidden="true" />
          {done ? "All answered" : `Question ${at + 1} of ${queue.length}`}
        </span>
      </div>

      <div className="clarify-body">
        <header className="clarify-head">
          <h1>{draft.title}</h1>
          <p>
            {interpreterLabel} drafted this workflow but could not settle{" "}
            <strong>
              {countWord(queue.length)} thing{queue.length === 1 ? "" : "s"}
            </strong>
            . Answer {queue.length === 1 ? "it" : "them"} one at a time and the workflow opens
            with your answers applied.
          </p>
        </header>

        {question ? (
          <section className="clarify-card" aria-label="Open question">
            <div className="clarify-card-head">
              <span className="chip unclear">Unclear</span>
              <span className="spacer" />
              <span className="clarify-where">{questionLocator(question, draft)}</span>
            </div>

            <p className="clarify-question">{question.question}</p>
            <p className="clarify-why">
              {question.why ??
                `${interpreterLabel} could not tell from the prompt, and the answer changes what gets built.`}
            </p>

            {question.options.length > 0 ? (
              <div className="clarify-picks">
                {question.options.map((option) => (
                  // A quick pick answers and advances in one press: it is an
                  // unambiguous choice, and confirming it would be a second
                  // click for nothing.
                  <button key={option} type="button" onClick={() => commit(option)}>
                    {option}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="clarify-own">
              <input
                ref={field}
                value={typed}
                placeholder="Or answer in your own words"
                aria-label="Answer in your own words"
                onChange={(event) => setTyped(event.target.value)}
                // Typing never advances. Enter commits, so a half-typed answer
                // cannot be submitted by a stray keystroke.
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commit(typed);
                  }
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={typed.trim().length === 0}
                onClick={() => commit(typed)}
              >
                {last ? "Done" : "Next"}
              </button>
            </div>
          </section>
        ) : (
          <section className="clarify-done" aria-label="All answered">
            <span className="clarify-tick" aria-hidden="true">
              ✓
            </span>
            <p className="clarify-done-title">
              {queue.length === 1 ? "Your answer is in." : `All ${countWord(queue.length)} answers are in.`}
            </p>
            <p className="clarify-done-note">
              They go into the brief and the steps they were asked about – what you typed is
              what the workflow says. Nothing is sent back to {interpreterLabel}.
            </p>
            <button type="button" className="primary" onClick={() => onOpen(answers)}>
              Open the workflow
            </button>
          </section>
        )}

        {!done ? (
          <footer className="clarify-foot">
            <div className="clarify-dots" aria-hidden="true">
              {queue.map((item, index) => (
                <i
                  key={item.id}
                  className={index < at ? "is-answered" : index === at ? "is-current" : undefined}
                />
              ))}
            </div>
            {/* A link, not a button: always available, never competing with the
                answer. The consequence it names is true — the questions are
                persisted with the workflow either way. */}
            <button type="button" className="link clarify-skip" onClick={() => onOpen(answers)}>
              Skip – open it as drafted, unanswered questions stay with the workflow
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
