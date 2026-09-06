/**
 * Defaults for the task brief.
 *
 * These are the guardrails that otherwise get retyped by hand into every
 * prompt. They are defaults rather than fixed text: a workflow that sets its
 * own `constraints` or `report` replaces them entirely, so the author is never
 * stuck with wording that does not fit.
 */

import type { WorkflowBrief, Workflow } from "@anthill/workflow-schema";

/**
 * The last of these is the one that matters most: an agent that cannot solve
 * the real problem will often make the check pass instead, and it takes an
 * explicit instruction to stop that.
 */
export const DEFAULT_CONSTRAINTS: readonly string[] = [
  "Stay on this task. Do not switch to unrelated work.",
  "Make the smallest reasonable change. Do not refactor beyond what the goal requires.",
  "Do not make a check pass without fixing the underlying issue.",
];

export const DEFAULT_REPORT_SECTIONS: readonly string[] = [
  "Root cause",
  "Changes made",
  "How it was verified",
  "Remaining risks",
];

/** A brief with defaults filled in, ready to render. */
export type ResolvedBrief = {
  goal?: string;
  context?: string;
  assumptions: string[];
  verification?: string;
  doneCriteria: string[];
  constraints: string[];
  prohibitedActions: string[];
  finalAction?: string;
  report: string[];
};

function cleanList(
  values: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const cleaned = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

/**
 * Merge a workflow's brief with the defaults.
 *
 * `goal` falls back to the workflow description, since a workflow that says what it
 * is usually says what it is for. `doneCriteria` has no default — inventing one
 * would be worse than leaving the section out, and validation requires it
 * wherever the diagram loops.
 */
export function resolveBrief(workflow: Workflow): ResolvedBrief {
  const brief: WorkflowBrief = workflow.brief ?? {};
  return {
    goal: brief.goal?.trim() || workflow.description?.trim() || undefined,
    context: brief.context?.trim() || undefined,
    assumptions: cleanList(brief.assumptions, []),
    verification: brief.verification?.trim() || undefined,
    doneCriteria: cleanList(brief.doneCriteria, []),
    constraints: cleanList(brief.constraints, DEFAULT_CONSTRAINTS),
    prohibitedActions: cleanList(brief.prohibitedActions, []),
    finalAction: brief.finalAction?.trim() || undefined,
    report: cleanList(brief.report, DEFAULT_REPORT_SECTIONS),
  };
}
