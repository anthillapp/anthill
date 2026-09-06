/**
 * Canonical workflow data model for Anthill.
 *
 * This module is the single source of truth for the shapes shared by every
 * other `@anthill/*` package. Runtime (zod) mirrors live in `./schemas.ts`,
 * structural graph validation lives in `./validate.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Workflow definition                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The coding-agent harness a workflow is authored for.
 *
 * In workflow mode the target is chosen once for the whole diagram — it decides
 * which models are offered and what the generated prompt looks like — rather
 * than per node. Optional so that execution-mode workflows, where each agent
 * node names its own `runtime`, stay valid.
 */
export type HarnessTarget = "claude-code" | "codex";

export const HARNESS_TARGETS = [
  "claude-code",
  "codex",
] as const satisfies readonly HarnessTarget[];

/**
 * What the work has to achieve, and what counts as finished.
 *
 * Separate from `description` on purpose: a description says what a workflow
 * is, while a brief says when to stop. `doneCriteria` in particular is the real
 * exit condition of a feedback loop — an attempt limit only says when to give
 * up, which is not the same thing.
 */
export type WorkflowBrief = {
  goal?: string;
  /** The project or task this workflow sits in — what an agent needs to know first. */
  context?: string;
  /** What is taken as given, so a reader can challenge it rather than discover it. */
  assumptions?: string[];
  /** How to check the goal was actually met. */
  verification?: string;
  /**
   * Acceptance criteria: each item must hold before the work is finished. Also
   * the exit condition for any loop in the workflow, which is why a looping workflow
   * cannot be compiled without them.
   */
  doneCriteria?: string[];
  /** Guardrails, e.g. "do not refactor beyond what the goal requires". */
  constraints?: string[];
  /** Things the workflow must never do, stated separately so they are hard to miss. */
  prohibitedActions?: string[];
  /** The concrete last thing to do — open a PR, write a summary, hand back a diff. */
  finalAction?: string;
  /** Sections the final report must cover. */
  report?: string[];
};

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  version: string;
  target?: HarnessTarget;
  brief?: WorkflowBrief;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  inputs?: WorkflowInput[];
  metadata?: Record<string, unknown>;
};

export type WorkflowInputType = "string" | "number" | "boolean" | "json";

export type WorkflowInput = {
  name: string;
  type: WorkflowInputType;
  description?: string;
  required?: boolean;
  default?: unknown;
};

export type NodeType =
  | "start"
  | "agent"
  | "approval"
  | "condition"
  | "command"
  | "end";

/** All node types, in canonical order. Useful for palettes / exhaustive checks. */
export const NODE_TYPES = [
  "start",
  "agent",
  "approval",
  "condition",
  "command",
  "end",
] as const satisfies readonly NodeType[];

export type NodePosition = {
  x: number;
  y: number;
};

export type WorkflowNode = {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  position?: NodePosition;
};

/**
 * Which side of a block a connection attaches to.
 *
 * Purely presentational: the engine ignores it. It exists so a diagram round
 * trips looking the way it was drawn — a loop routed under the blocks stays
 * under them instead of snapping back across the forward edges.
 */
export type EdgeAnchor = "top" | "right" | "bottom" | "left";

export const EDGE_ANCHORS = [
  "top",
  "right",
  "bottom",
  "left",
] as const satisfies readonly EdgeAnchor[];

/**
 * What a connection means, not merely where it goes.
 *
 * The kind decides how the path is drawn and how the generated workflow describes
 * it: `next` is work accepted, `rework` is work sent back, `question` needs an
 * answer from someone else, `stop` ends the path.
 */
export type OutcomeKind = "next" | "rework" | "question" | "stop";

export const OUTCOME_KINDS = [
  "next",
  "rework",
  "question",
  "stop",
] as const satisfies readonly OutcomeKind[];

/**
 * A point on a block's box, in fractions of it from the top-left corner.
 *
 * Used for both ends of a connection: where it lands on its target, and where
 * its port sits on its source. Purely presentational, like `position` on a
 * node — the author points at a spot and it stays there instead of snapping to
 * the middle of a side.
 */
export type EdgeAnchorPoint = { u: number; v: number };

/**
 * How a connection is drawn between its two ends.
 *
 * `curved` is a single bezier; `orthogonal` is a stepped line of horizontal and
 * vertical segments. Both carry the same meaning — this is how the author wants
 * the diagram to read, nothing more.
 */
export type EdgeRouting = "curved" | "orthogonal";

export const EDGE_ROUTINGS = [
  "curved",
  "orthogonal",
] as const satisfies readonly EdgeRouting[];

/**
 * How far the author pulled the line away from the shape it would take on its
 * own, in fractions of the straight line between its ends.
 *
 * `along` slides the bend towards one end or the other; `across` pushes it off
 * to one side. Relative rather than absolute, so the shape survives moving
 * either block. Absent means the default shape.
 */
export type EdgeBend = { along: number; across: number };

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  condition?: EdgeCondition;
  label?: string;
  /** What this path means. Defaults to `next` when unset. */
  kind?: OutcomeKind;
  /** Exact landing point on the target block. */
  anchor?: EdgeAnchorPoint;
  /** Where the port sits on the source block. Defaults to the right edge. */
  port?: EdgeAnchorPoint;
  /** How the line is drawn. Defaults to `curved` when unset. */
  routing?: EdgeRouting;
  /** The author's adjustment to the line's shape. */
  bend?: EdgeBend;
  /** Side of the source block the connection leaves from. */
  sourceHandle?: EdgeAnchor;
  /** Side of the target block the connection arrives at. */
  targetHandle?: EdgeAnchor;
};

/**
 * A guard expression on an edge, e.g. `review.status == "approved"`.
 *
 * MVP grammar (see `parseEdgeCondition`):
 *   <dotted.path> (== | !=) <quoted-string | number | true | false>
 */
export type EdgeCondition = string;

/* -------------------------------------------------------------------------- */
/* Node configs                                                               */
/* -------------------------------------------------------------------------- */

/**
 * JSON-schema-like description of the extra fields an agent is expected to
 * produce on top of the base `AgentResult`. Intentionally loose for the MVP.
 */
export type OutputSchema = Record<string, unknown>;

export type PermissionPolicy = {
  readOnly?: boolean;
  editFiles?: boolean;
  runCommands?: boolean;
  networkAllowed?: boolean;
  requireApprovalForDestructive?: boolean;
};

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs?: number;
};

export type AgentNodeConfig = {
  agentId?: string;
  role: string;
  runtime: string;
  model?: string;
  instructions: string;
  inputs?: Record<string, string>;
  outputs?: OutputSchema;
  tools?: string[];
  permissions?: PermissionPolicy;
  workingDirectory?: string;
  successCriteria?: string;
  retryPolicy?: RetryPolicy;
};

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type AgentResultStatus =
  | "success"
  | "failed"
  | "cancelled"
  | "requires_approval";

export type IssueSeverity = "low" | "medium" | "high" | "critical";

export type Issue = {
  severity: IssueSeverity;
  title: string;
  file?: string;
  description?: string;
};

/**
 * Deliberately open-ended: `durationMs`, `tokensUsed` and `filesChanged` are
 * the common fields, but runtimes may report anything else.
 */
export type RunMetrics = {
  durationMs?: number;
  tokensUsed?: number;
  filesChanged?: number;
} & Record<string, unknown>;

/**
 * Artifact `type` is an open string union — these are the well-known values,
 * not an exhaustive list.
 */
export const KNOWN_ARTIFACT_TYPES = [
  "summary",
  "file",
  "patch",
  "diff",
  "test_report",
  "review",
  "log",
] as const;

export type KnownArtifactType = (typeof KNOWN_ARTIFACT_TYPES)[number];

export type Artifact = {
  id: string;
  /** e.g. "summary" | "file" | "patch" | "diff" | "test_report" | "review" | "log" */
  type: string;
  title: string;
  path?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

export type AgentResult = {
  status: AgentResultStatus;
  summary: string;
  decision?: string;
  artifacts: Artifact[];
  issues: Issue[];
  metrics?: RunMetrics;
  metadata: Record<string, unknown>;
};

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "success"
  | "failed"
  | "cancelled";

export type NodeRunStatus =
  | "queued"
  | "running"
  | "skipped"
  | "success"
  | "failed"
  | "paused";

export type LogRef = {
  id: string;
  path: string;
  kind?: string;
};

export type NodeRun = {
  id: string;
  nodeId: string;
  attempt: number;
  status: NodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
  logs?: LogRef[];
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowVersion: string;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt?: string;
  nodeRuns: NodeRun[];
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type ValidationError = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  /**
   * Advisories: true of the workflow, but not reasons to refuse it.
   *
   * Separate from `errors` so `valid` keeps meaning "this can be compiled".
   * A step that never says what it produces still compiles; it just produces a
   * weaker prompt, and that is worth saying without blocking anything.
   */
  warnings?: ValidationError[];
};
