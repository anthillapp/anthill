/**
 * The three things a first-run reader asks, in the order they ask them: what
 * do I build here, what do I do with it, and what do I get back?
 *
 * One array, read by both panes. Two copies of the same prose means editing
 * the wrong one is a silent no-op, which is exactly what happened while this
 * screen was being designed.
 */

export type ExplainStep = { title: string; body: string };

export const EXPLAIN_STEPS: readonly ExplainStep[] = [
  {
    title: "Design the workflow",
    body: "Lay out the steps and connect them. A step says what to do and which agent does it; a connection says what has to be true to take that path — work accepted, sent back, or a question that needs answering.",
  },
  {
    title: "Hand it over",
    body: "Anthill writes an agent file per role into your project, then compiles the whole workflow into one prompt with a run marker at the top. You copy it, paste it into Claude Code or Codex, and start the session yourself.",
  },
  {
    title: "Watch it run",
    body: "With local hooks enabled, Anthill recognises that session from the marker and shows the workflow live: which step is working, what came back, where it looped. When it cannot tell, it says so rather than guessing.",
  },
];
