/**
 * Workflow contracts used by `@anthill/builder`.
 *
 * `Workflow`, `WorkflowNode`, `WorkflowEdge`, `NodeType`, `ValidationError` and
 * `ValidationResult` are re-exported from `@anthill/workflow-schema`, the
 * canonical workflow data model — this used to be a local mirror (see
 * `docs/workflow-model.md`), replaced now that the schema package exists.
 *
 * `AgentNodeConfig` here is intentionally NOT the canonical one: it's a
 * builder-local, fully-optional "form" shape for the property panel, which
 * must allow an agent node to be mid-edit (e.g. role filled in, runtime not
 * yet chosen) before validation runs.
 */

export type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  EdgeAnchor,
  NodeType,
  NodePosition as Position,
  ValidationError,
  ValidationResult,
} from "@anthill/workflow-schema";

export { NODE_TYPES } from "@anthill/workflow-schema";

/**
 * Editable subset of `AgentNodeConfig` for the MVP property panel. Fields are
 * optional here because the form allows partial edits; full validation
 * (required role/runtime/instructions) is enforced by `validateWorkflow` from
 * `@anthill/workflow-schema`, not by this type.
 */
export type AgentNodeConfig = {
  role?: string;
  runtime?: string;
  model?: string;
  instructions?: string;
  workingDirectory?: string;
  successCriteria?: string;
};
