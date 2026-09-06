import type { AgentRunContext } from "./contracts.js";

/**
 * The example `AgentResult` shape handed to the agent so it knows what to
 * print. Kept as a literal (rather than generated) so the wording stays stable
 * and reviewable — CLIs are sensitive to prompt churn.
 */
const EXPECTED_OUTPUT_EXAMPLE = {
  status: "success | failed | cancelled | requires_approval",
  summary: "One short paragraph describing what you did and why.",
  decision: "(optional) the decision you reached, if this role makes one",
  artifacts: [
    {
      id: "unique-artifact-id",
      type: "file | diff | report | note | ...",
      title: "Human readable title",
      path: "(optional) path relative to the workspace",
      content: "(optional) inline content",
      metadata: {},
    },
  ],
  issues: [
    {
      severity: "low | medium | high | critical",
      title: "Short problem statement",
      file: "(optional) path relative to the workspace",
      description: "(optional) details and suggested remediation",
    },
  ],
  metrics: {},
  metadata: {},
};

/**
 * Builds the prompt every Anthill agent invocation is wrapped in.
 *
 * Pure function — no I/O, no clock, no randomness — so it is trivially
 * snapshot-testable and identical across every runtime adapter.
 */
export function buildPromptEnvelope(ctx: AgentRunContext): string {
  const priorResults = JSON.stringify(ctx.priorResults ?? {}, null, 2);
  const expectedOutput = JSON.stringify(EXPECTED_OUTPUT_EXAMPLE, null, 2);

  return [
    "You are running as part of an Anthill workflow.",
    "",
    "Role:",
    ctx.role,
    "",
    "Task:",
    ctx.instructions,
    "",
    "Workspace:",
    ctx.workingDirectory,
    "",
    "Prior Results:",
    priorResults,
    "",
    "Expected Output:",
    "Return JSON matching this schema:",
    expectedOutput,
    "",
  ].join("\n");
}
