/**
 * Validation issues, arranged for the thing that has them.
 *
 * The Problems list is an index of everything wrong with a workflow; it is not a
 * place anyone wants to work. Someone who has selected a block and cannot see
 * why it is marked has to leave it, read a list, and come back — so the same
 * issues are also served per block and per connection, which is what this is
 * for.
 *
 * Severity is two-valued and both values are real: an error stops the workflow
 * compiling, an advisory is true of it but not a reason to refuse it.
 */

import type { ValidationError, ValidationResult } from "@anthill/workflow-schema";

import { WORKFLOWNER_ADVISORY_CODES, WORKFLOWNER_VALIDATION_CODES } from "./workflow.js";

export type IssueSeverity = "error" | "advisory";

export type WorkflowIssue = ValidationError & {
  severity: IssueSeverity;
  /**
   * Where in the inspector the fix lives, when the issue has one obvious home.
   * The UI turns this into a control that puts the author in front of the
   * field rather than describing where to find it.
   */
  fix?: IssueFix;
};

export type IssueFix =
  | { kind: "step-field"; tab: "task" | "data" | "limits"; label: string }
  | { kind: "connect-output"; outputId: string; label: string }
  | { kind: "edit-agent"; label: string };

const CODES = WORKFLOWNER_VALIDATION_CODES;
const ADVISORIES = WORKFLOWNER_ADVISORY_CODES;

/**
 * Where each issue is fixed.
 *
 * Only codes with a single obvious answer appear. A problem whose fix is "think
 * about the shape of your workflow" gets no button, because a control that jumps
 * somewhere unhelpful is worse than none.
 */
function fixFor(error: ValidationError): IssueFix | undefined {
  switch (error.code) {
    case CODES.STEP_MISSING_ACTION:
      return { kind: "step-field", tab: "task", label: "Choose an action" };
    case CODES.STEP_MISSING_TASK:
      return { kind: "step-field", tab: "task", label: "Write the task" };
    case CODES.STEP_MISSING_AGENT:
    case CODES.STEP_UNKNOWN_AGENT:
      return { kind: "step-field", tab: "task", label: "Assign an agent" };
    case CODES.UNBOUNDED_LOOP:
      return { kind: "step-field", tab: "limits", label: "Set a pass limit" };
    case CODES.AGENT_MISSING_NAME:
    case CODES.DUPLICATE_AGENT_NAME:
      return { kind: "edit-agent", label: "Edit the agent" };
    case ADVISORIES.AGENT_NO_MODEL_FOR_TARGET:
      return { kind: "edit-agent", label: "Choose a model" };
    case ADVISORIES.STEP_NO_EXPECTED_OUTPUT:
    case ADVISORIES.STEP_NO_SUCCESS_CRITERIA:
      return { kind: "step-field", tab: "data", label: "Fill this in" };
    // `WORKFLOW_NO_GOAL` and `LOOP_WITHOUT_DONE_CRITERIA` used to offer "Open the
    // brief". The brief has no editing surface in this pass, so they carry no
    // fix: the message still says what is missing, and a button that led
    // nowhere would be worse than none.
    default:
      return undefined;
  }
}

function withSeverity(
  errors: readonly ValidationError[],
  severity: IssueSeverity,
): WorkflowIssue[] {
  return errors.map((error) => {
    const fix = fixFor(error);
    return { ...error, severity, ...(fix ? { fix } : {}) };
  });
}

/** Every issue in a workflow, errors before advisories. */
export function allIssues(validation: ValidationResult): WorkflowIssue[] {
  return [
    ...withSeverity(validation.errors, "error"),
    ...withSeverity(validation.warnings ?? [], "advisory"),
  ];
}

/**
 * The issues belonging to one block.
 *
 * An unconnected output is reported against the block it leaves, so it appears
 * here; `outputId` is threaded through so the fix can offer to connect that
 * particular one.
 */
export function issuesForNode(
  validation: ValidationResult,
  nodeId: string,
  options: { unconnectedOutputId?: string } = {},
): WorkflowIssue[] {
  return allIssues(validation)
    .filter((issue) => issue.nodeId === nodeId && !issue.edgeId)
    .map((issue) =>
      issue.code === CODES.OUTPUT_NOT_CONNECTED && options.unconnectedOutputId
        ? {
            ...issue,
            fix: {
              kind: "connect-output",
              outputId: options.unconnectedOutputId,
              label: "Connect it",
            } as const,
          }
        : issue,
    );
}

/** The issues belonging to one connection. */
export function issuesForEdge(validation: ValidationResult, edgeId: string): WorkflowIssue[] {
  return allIssues(validation).filter((issue) => issue.edgeId === edgeId);
}

/** Issues that belong to the workflow rather than to anything in it. */
export function workflowLevelIssues(validation: ValidationResult): WorkflowIssue[] {
  return allIssues(validation).filter((issue) => !issue.nodeId && !issue.edgeId);
}
