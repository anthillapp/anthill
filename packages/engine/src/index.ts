export type {
  AgentNodeConfig,
  AgentResult,
  AgentResultStatus,
  ApprovalDecision,
  ApprovalGatePort,
  Artifact,
  Issue,
  IssueSeverity,
  LogRef,
  NodeRun,
  NodeRunStatus,
  NodeType,
  RetryPolicy,
  RunStorePort,
  RuntimeAdapterPort,
  RuntimeRunContext,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStatus,
} from "./contracts.js";

export {
  ExpressionError,
  evaluateExpression,
  isValidExpression,
  parseExpression,
  resolvePath,
} from "./expression.js";
export type { ComparisonOperator, ExpressionLiteral, ParsedExpression } from "./expression.js";

export {
  DEFAULT_LIMITS,
  ENGINE_ERROR_CODE_KEY,
  ENGINE_ERROR_MESSAGE_KEY,
  EngineError,
  NotImplementedError,
  WorkflowEngine,
  WorkflowValidationError,
  getRunFailureReason,
  validateWorkflow,
} from "./engine.js";
export type {
  EngineErrorCode,
  EngineLimits,
  RunFailure,
  RunOptions,
  WorkflowEngineOptions,
} from "./engine.js";

export { adaptAgentRuntime } from "./runtime-adapter.js";

export const PACKAGE_NAME = "@anthill/engine";
