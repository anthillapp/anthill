/**
 * Local structural validation for the canvas.
 *
 * This is a deliberate SUBSET of the rules in `docs/visual-builder.md`, chosen
 * because they are cheap and directly actionable while authoring:
 *
 *   - exactly one `start` node
 *   - no dangling edges
 *   - `agent` nodes have non-empty `role`, `runtime` and `instructions`
 *   - `approval` nodes have at least one outgoing edge (a resume path)
 *   - (cheap extra) node/edge ids are unique
 *
 * Deferred to `@anthill/workflow-schema` at integration time: reachability from
 * start, loop attempt limits, condition-expression parsing, runtime-configured
 * checks. When that package lands, this module should become a thin re-export
 * of the canonical validator (keeping the same `ValidationResult` shape).
 */

import type {
  ValidationError,
  ValidationResult,
  Workflow,
  WorkflowNode,
} from "./contracts";

export const ValidationCode = {
  MISSING_START_NODE: "MISSING_START_NODE",
  MULTIPLE_START_NODES: "MULTIPLE_START_NODES",
  DANGLING_EDGE: "DANGLING_EDGE",
  DUPLICATE_NODE_ID: "DUPLICATE_NODE_ID",
  DUPLICATE_EDGE_ID: "DUPLICATE_EDGE_ID",
  AGENT_MISSING_ROLE: "AGENT_MISSING_ROLE",
  AGENT_MISSING_RUNTIME: "AGENT_MISSING_RUNTIME",
  AGENT_MISSING_INSTRUCTIONS: "AGENT_MISSING_INSTRUCTIONS",
  APPROVAL_NO_OUTGOING_EDGE: "APPROVAL_NO_OUTGOING_EDGE",
} as const;

export type ValidationCodeValue =
  (typeof ValidationCode)[keyof typeof ValidationCode];

export function validate(workflow: Workflow): ValidationResult {
  const errors: ValidationError[] = [
    ...validateStartNodes(workflow),
    ...validateDuplicateIds(workflow),
    ...validateEdges(workflow),
    ...validateAgentNodes(workflow),
    ...validateApprovalNodes(workflow),
  ];
  return { valid: errors.length === 0, errors };
}

/** Errors attached to a specific node, for inline canvas badges. */
export function errorsForNode(
  result: ValidationResult,
  nodeId: string,
): ValidationError[] {
  return result.errors.filter((error) => error.nodeId === nodeId);
}

/** Errors attached to a specific edge. */
export function errorsForEdge(
  result: ValidationResult,
  edgeId: string,
): ValidationError[] {
  return result.errors.filter((error) => error.edgeId === edgeId);
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function validateStartNodes(workflow: Workflow): ValidationError[] {
  const startNodes = workflow.nodes.filter((node) => node.type === "start");
  if (startNodes.length === 0) {
    return [
      {
        code: ValidationCode.MISSING_START_NODE,
        message: "Workflow must have exactly one start node.",
      },
    ];
  }
  if (startNodes.length > 1) {
    return startNodes.map((node) => ({
      code: ValidationCode.MULTIPLE_START_NODES,
      message: `Workflow has ${startNodes.length} start nodes; exactly one is allowed.`,
      nodeId: node.id,
    }));
  }
  return [];
}

function validateDuplicateIds(workflow: Workflow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const id of duplicates(workflow.nodes.map((node) => node.id))) {
    errors.push({
      code: ValidationCode.DUPLICATE_NODE_ID,
      message: `Duplicate node id "${id}".`,
      nodeId: id,
    });
  }
  for (const id of duplicates(workflow.edges.map((edge) => edge.id))) {
    errors.push({
      code: ValidationCode.DUPLICATE_EDGE_ID,
      message: `Duplicate edge id "${id}".`,
      edgeId: id,
    });
  }
  return errors;
}

function validateEdges(workflow: Workflow): ValidationError[] {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const errors: ValidationError[] = [];
  for (const edge of workflow.edges) {
    const missing: string[] = [];
    if (!nodeIds.has(edge.source)) missing.push(`source "${edge.source}"`);
    if (!nodeIds.has(edge.target)) missing.push(`target "${edge.target}"`);
    if (missing.length > 0) {
      errors.push({
        code: ValidationCode.DANGLING_EDGE,
        message: `Edge "${edge.id}" references unknown ${missing.join(" and ")}.`,
        edgeId: edge.id,
      });
    }
  }
  return errors;
}

function validateAgentNodes(workflow: Workflow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const node of workflow.nodes) {
    if (node.type !== "agent") continue;
    if (!hasText(node, "role")) {
      errors.push(agentError(node, ValidationCode.AGENT_MISSING_ROLE, "role"));
    }
    if (!hasText(node, "runtime")) {
      errors.push(
        agentError(node, ValidationCode.AGENT_MISSING_RUNTIME, "runtime"),
      );
    }
    if (!hasText(node, "instructions")) {
      errors.push(
        agentError(
          node,
          ValidationCode.AGENT_MISSING_INSTRUCTIONS,
          "instructions",
        ),
      );
    }
  }
  return errors;
}

function validateApprovalNodes(workflow: Workflow): ValidationError[] {
  const sources = new Set(workflow.edges.map((edge) => edge.source));
  return workflow.nodes
    .filter((node) => node.type === "approval" && !sources.has(node.id))
    .map((node) => ({
      code: ValidationCode.APPROVAL_NO_OUTGOING_EDGE,
      message: `Approval node "${node.name || node.id}" needs at least one outgoing edge (a resume path).`,
      nodeId: node.id,
    }));
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function agentError(
  node: WorkflowNode,
  code: string,
  field: string,
): ValidationError {
  return {
    code,
    message: `Agent node "${node.name || node.id}" is missing ${field}.`,
    nodeId: node.id,
  };
}

function hasText(node: WorkflowNode, key: string): boolean {
  const value = node.config[key];
  return typeof value === "string" && value.trim().length > 0;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}
