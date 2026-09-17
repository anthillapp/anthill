/**
 * Runtime (zod) mirrors of the types in `./types.ts`.
 *
 * Every schema is named `<Type>Schema`. The TypeScript types remain the source
 * of truth for the contract; these schemas exist to validate untrusted input
 * (files on disk, IPC payloads, runtime output).
 */

import { z } from "zod";

import type {
  AgentNodeConfig,
  AgentResult,
  Artifact,
  Issue,
  LogRef,
  NodeRun,
  PermissionPolicy,
  RetryPolicy,
  RunMetrics,
  Workflow,
  WorkflowEdge,
  WorkflowInput,
  WorkflowNode,
  WorkflowRun,
} from "./types.js";
import {
  EDGE_ANCHORS,
  EDGE_ROUTINGS,
  HARNESS_TARGETS,
  NODE_ID_PATTERN,
  OUTCOME_KINDS,
} from "./types.js";

const nonEmptyString = z.string().min(1);

/** A workflow node id: non-empty and drawn from the class the progress channels accept. */
const nodeId = z.string().regex(
  NODE_ID_PATTERN,
  `node id must match ${NODE_ID_PATTERN.source}`,
);

/** `Record<string, unknown>` — written two-arg so it works on zod 3 and 4. */
const unknownRecord = z.record(z.string(), z.unknown());

/* -------------------------------------------------------------------------- */
/* Workflow definition                                                        */
/* -------------------------------------------------------------------------- */

export const WorkflowInputTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "json",
]);

export const WorkflowInputSchema = z.object({
  name: nonEmptyString,
  type: WorkflowInputTypeSchema,
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

export const NodeTypeSchema = z.enum([
  "start",
  "agent",
  "approval",
  "condition",
  "command",
  "end",
]);

export const NodePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowNodeSchema = z.object({
  id: nodeId,
  type: NodeTypeSchema,
  name: z.string(),
  config: unknownRecord,
  position: NodePositionSchema.optional(),
});

/** Edge conditions are free-form strings here; grammar is checked by `validateWorkflow`. */
export const EdgeConditionSchema = z.string();

export const EdgeAnchorSchema = z.enum(EDGE_ANCHORS);
export const OutcomeKindSchema = z.enum(OUTCOME_KINDS);
export const EdgeAnchorPointSchema = z.object({
  u: z.number(),
  v: z.number(),
});
export const EdgeRoutingSchema = z.enum(EDGE_ROUTINGS);
export const EdgeBendSchema = z.object({
  along: z.number(),
  across: z.number(),
});

export const WorkflowEdgeSchema = z.object({
  id: nonEmptyString,
  source: nonEmptyString,
  target: nonEmptyString,
  condition: EdgeConditionSchema.optional(),
  label: z.string().optional(),
  kind: OutcomeKindSchema.optional(),
  anchor: EdgeAnchorPointSchema.optional(),
  port: EdgeAnchorPointSchema.optional(),
  routing: EdgeRoutingSchema.optional(),
  bend: EdgeBendSchema.optional(),
  sourceHandle: EdgeAnchorSchema.optional(),
  targetHandle: EdgeAnchorSchema.optional(),
});

export const HarnessTargetSchema = z.enum(HARNESS_TARGETS);

export const WorkflowBriefSchema = z.object({
  goal: z.string().optional(),
  context: z.string().optional(),
  assumptions: z.array(z.string()).optional(),
  verification: z.string().optional(),
  doneCriteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  prohibitedActions: z.array(z.string()).optional(),
  finalAction: z.string().optional(),
  report: z.array(z.string()).optional(),
});

export const WorkflowSchema = z.object({
  id: nonEmptyString,
  name: z.string(),
  description: z.string().optional(),
  version: nonEmptyString,
  target: HarnessTargetSchema.optional(),
  brief: WorkflowBriefSchema.optional(),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  inputs: z.array(WorkflowInputSchema).optional(),
  metadata: unknownRecord.optional(),
});

/* -------------------------------------------------------------------------- */
/* Node configs                                                               */
/* -------------------------------------------------------------------------- */

export const OutputSchemaSchema = unknownRecord;

export const PermissionPolicySchema = z.object({
  readOnly: z.boolean().optional(),
  editFiles: z.boolean().optional(),
  runCommands: z.boolean().optional(),
  networkAllowed: z.boolean().optional(),
  requireApprovalForDestructive: z.boolean().optional(),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1),
  backoffMs: z.number().min(0).optional(),
});

export const AgentNodeConfigSchema = z.object({
  agentId: z.string().optional(),
  role: nonEmptyString,
  runtime: nonEmptyString,
  model: z.string().optional(),
  instructions: nonEmptyString,
  inputs: z.record(z.string(), z.string()).optional(),
  outputs: OutputSchemaSchema.optional(),
  tools: z.array(z.string()).optional(),
  permissions: PermissionPolicySchema.optional(),
  workingDirectory: z.string().optional(),
  successCriteria: z.string().optional(),
  retryPolicy: RetryPolicySchema.optional(),
});

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export const AgentResultStatusSchema = z.enum([
  "success",
  "failed",
  "cancelled",
  "requires_approval",
]);

export const IssueSeveritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const IssueSchema = z.object({
  severity: IssueSeveritySchema,
  title: z.string(),
  file: z.string().optional(),
  description: z.string().optional(),
});

/** Open-ended: known numeric fields plus anything else the runtime reports. */
export const RunMetricsSchema = z
  .object({
    durationMs: z.number().optional(),
    tokensUsed: z.number().optional(),
    filesChanged: z.number().optional(),
  })
  .catchall(z.unknown());

export const ArtifactSchema = z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  title: z.string(),
  path: z.string().optional(),
  content: z.string().optional(),
  metadata: unknownRecord.optional(),
});

export const AgentResultSchema = z.object({
  status: AgentResultStatusSchema,
  summary: z.string(),
  decision: z.string().optional(),
  artifacts: z.array(ArtifactSchema),
  issues: z.array(IssueSchema),
  metrics: RunMetricsSchema.optional(),
  metadata: unknownRecord,
});

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "success",
  "failed",
  "cancelled",
]);

export const NodeRunStatusSchema = z.enum([
  "queued",
  "running",
  "skipped",
  "success",
  "failed",
  "paused",
]);

export const LogRefSchema = z.object({
  id: nonEmptyString,
  path: nonEmptyString,
  kind: z.string().optional(),
});

export const NodeRunSchema = z.object({
  id: nonEmptyString,
  nodeId: nonEmptyString,
  attempt: z.number().int().min(0),
  status: NodeRunStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  result: AgentResultSchema.optional(),
  logs: z.array(LogRefSchema).optional(),
});

export const WorkflowRunSchema = z.object({
  id: nonEmptyString,
  workflowId: nonEmptyString,
  workflowVersion: z.string(),
  status: WorkflowRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  nodeRuns: z.array(NodeRunSchema),
});

/* -------------------------------------------------------------------------- */
/* Validation result                                                          */
/* -------------------------------------------------------------------------- */

export const ValidationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(ValidationErrorSchema),
});

/* -------------------------------------------------------------------------- */
/* Parse helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Thrown by `parseWorkflow` (and friends) when zod validation fails. */
export class SchemaValidationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(label: string, error: z.ZodError) {
    super(`${label}: ${formatZodIssues(error)}`);
    this.name = "SchemaValidationError";
    this.issues = error.issues as z.ZodIssue[];
  }
}

function formatZodIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.map((p) => String(p)).join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return lines.length > 0 ? lines.join("; ") : "unknown validation error";
}

function parseWith<T>(schema: z.ZodType<T>, label: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new SchemaValidationError(label, result.error);
  }
  return result.data;
}

/** Parse + validate an unknown value as a `Workflow`. Throws on failure. */
export function parseWorkflow(input: unknown): Workflow {
  return parseWith(WorkflowSchema as z.ZodType<Workflow>, "Invalid workflow", input);
}

/** Parse + validate an unknown value as an `AgentNodeConfig`. Throws on failure. */
export function parseAgentNodeConfig(input: unknown): AgentNodeConfig {
  return parseWith(
    AgentNodeConfigSchema as z.ZodType<AgentNodeConfig>,
    "Invalid agent node config",
    input,
  );
}

/** Parse + validate an unknown value as an `AgentResult`. Throws on failure. */
export function parseAgentResult(input: unknown): AgentResult {
  return parseWith(
    AgentResultSchema as z.ZodType<AgentResult>,
    "Invalid agent result",
    input,
  );
}

/** Parse + validate an unknown value as a `WorkflowRun`. Throws on failure. */
export function parseWorkflowRun(input: unknown): WorkflowRun {
  return parseWith(
    WorkflowRunSchema as z.ZodType<WorkflowRun>,
    "Invalid workflow run",
    input,
  );
}

/* -------------------------------------------------------------------------- */
/* Compile-time guards: schema output must be assignable to the TS contract.   */
/* -------------------------------------------------------------------------- */

type AssignableTo<Actual extends Expected, Expected> = Actual;

type _CheckWorkflow = AssignableTo<z.infer<typeof WorkflowSchema>, Workflow>;
type _CheckNode = AssignableTo<z.infer<typeof WorkflowNodeSchema>, WorkflowNode>;
type _CheckEdge = AssignableTo<z.infer<typeof WorkflowEdgeSchema>, WorkflowEdge>;
type _CheckInput = AssignableTo<z.infer<typeof WorkflowInputSchema>, WorkflowInput>;
type _CheckAgentConfig = AssignableTo<
  z.infer<typeof AgentNodeConfigSchema>,
  AgentNodeConfig
>;
type _CheckPermissions = AssignableTo<
  z.infer<typeof PermissionPolicySchema>,
  PermissionPolicy
>;
type _CheckRetry = AssignableTo<z.infer<typeof RetryPolicySchema>, RetryPolicy>;
type _CheckMetrics = AssignableTo<z.infer<typeof RunMetricsSchema>, RunMetrics>;
type _CheckArtifact = AssignableTo<z.infer<typeof ArtifactSchema>, Artifact>;
type _CheckIssue = AssignableTo<z.infer<typeof IssueSchema>, Issue>;
type _CheckAgentResult = AssignableTo<z.infer<typeof AgentResultSchema>, AgentResult>;
type _CheckLogRef = AssignableTo<z.infer<typeof LogRefSchema>, LogRef>;
type _CheckNodeRun = AssignableTo<z.infer<typeof NodeRunSchema>, NodeRun>;
type _CheckWorkflowRun = AssignableTo<z.infer<typeof WorkflowRunSchema>, WorkflowRun>;
