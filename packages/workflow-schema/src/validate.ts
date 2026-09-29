/**
 * Structural validation of a workflow graph.
 *
 * This is the "can this graph run?" pass that the visual builder shows inline
 * and the engine runs before starting a run. It assumes the input already has
 * the right *shape* (use `parseWorkflow` for that) and checks graph semantics.
 */

import type {
  EdgeCondition,
  ValidationError,
  ValidationResult,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./types.js";

import { NODE_ID_PATTERN } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Error codes                                                                */
/* -------------------------------------------------------------------------- */

export const VALIDATION_CODES = {
  DUPLICATE_NODE_ID: "DUPLICATE_NODE_ID",
  INVALID_NODE_ID: "INVALID_NODE_ID",
  DUPLICATE_EDGE_ID: "DUPLICATE_EDGE_ID",
  NO_START_NODE: "NO_START_NODE",
  MULTIPLE_START_NODES: "MULTIPLE_START_NODES",
  UNREACHABLE_NODE: "UNREACHABLE_NODE",
  DANGLING_EDGE_SOURCE: "DANGLING_EDGE_SOURCE",
  DANGLING_EDGE_TARGET: "DANGLING_EDGE_TARGET",
  AGENT_MISSING_ROLE: "AGENT_MISSING_ROLE",
  AGENT_MISSING_RUNTIME: "AGENT_MISSING_RUNTIME",
  AGENT_MISSING_INSTRUCTIONS: "AGENT_MISSING_INSTRUCTIONS",
  UNKNOWN_RUNTIME: "UNKNOWN_RUNTIME",
  INVALID_EDGE_CONDITION: "INVALID_EDGE_CONDITION",
  UNBOUNDED_LOOP: "UNBOUNDED_LOOP",
  APPROVAL_NODE_NO_OUTGOING_EDGE: "APPROVAL_NODE_NO_OUTGOING_EDGE",
} as const;

export type ValidationCode =
  (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];

export type ValidateWorkflowOptions = {
  /**
   * Runtime ids the host can actually execute (e.g. ["codex-cli", "claude-code"]).
   * When provided, every agent node's `config.runtime` must be one of them.
   */
  availableRuntimes?: string[];
};

/* -------------------------------------------------------------------------- */
/* Edge condition grammar                                                     */
/* -------------------------------------------------------------------------- */

export type ConditionOperator = "==" | "!=";

export type ConditionLiteral = string | number | boolean;

export type ParsedEdgeCondition = {
  /** Dotted path, split into segments: `review.status` -> ["review", "status"]. */
  path: string[];
  /** The dotted path exactly as written. */
  rawPath: string;
  operator: ConditionOperator;
  value: ConditionLiteral;
  valueType: "string" | "number" | "boolean";
};

export type ParseEdgeConditionResult =
  | { ok: true; condition: ParsedEdgeCondition }
  | { ok: false; error: string };

/**
 * A segment of a condition's dotted path.
 *
 * Hyphens are allowed because the first segment names an agent, and an agent
 * name becomes a slug: "Code Reviewer" is `code-reviewer`, and without hyphens
 * no condition could refer to any agent whose name is more than one word.
 * Interior only — a leading or trailing hyphen is a typo, not a name.
 */
const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)*";
const CONDITION_RE = new RegExp(
  `^\\s*(${IDENTIFIER}(?:\\.${IDENTIFIER})*)\\s*(==|!=)\\s*(\\S.*?)\\s*$`,
);
const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * The MVP edge-condition grammar:
 *
 *     <dotted.path> (== | !=) <quoted-string | number | true | false>
 *
 * Examples that parse:
 *   `review.status == "approved"`, `tests.failed != 0`, `gate.ok == true`
 *
 * Anything else (bare identifiers on the right, `&&`, `>`, function calls,
 * template strings) is rejected with a human-readable reason.
 */
export function parseEdgeCondition(
  condition: EdgeCondition,
): ParseEdgeConditionResult {
  if (typeof condition !== "string") {
    return { ok: false, error: "condition must be a string" };
  }

  const trimmed = condition.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "condition is empty" };
  }

  const match = CONDITION_RE.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error:
        `expected \`<dotted.path> == <value>\` or \`<dotted.path> != <value>\`, got \`${trimmed}\``,
    };
  }

  const [, rawPath, operator, rawValue] = match as unknown as [
    string,
    string,
    ConditionOperator,
    string,
  ];

  const literal = parseLiteral(rawValue);
  if (!literal.ok) {
    return {
      ok: false,
      error: `${literal.error} (in \`${trimmed}\`)`,
    };
  }

  return {
    ok: true,
    condition: {
      path: rawPath.split("."),
      rawPath,
      operator,
      value: literal.value,
      valueType: literal.valueType,
    },
  };
}

type ParseLiteralResult =
  | { ok: true; value: ConditionLiteral; valueType: "string" | "number" | "boolean" }
  | { ok: false; error: string };

function parseLiteral(raw: string): ParseLiteralResult {
  if (raw === "true" || raw === "false") {
    return { ok: true, value: raw === "true", valueType: "boolean" };
  }

  if (NUMBER_RE.test(raw)) {
    return { ok: true, value: Number(raw), valueType: "number" };
  }

  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    if (raw.length < 2 || raw[raw.length - 1] !== quote) {
      return { ok: false, error: `unterminated string literal \`${raw}\`` };
    }
    const body = raw.slice(1, -1);
    // Reject an unescaped closing quote in the middle (e.g. `"a" == "b"`).
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === "\\") {
        i += 1;
        continue;
      }
      if (body[i] === quote) {
        return { ok: false, error: `unexpected trailing input after string literal` };
      }
    }
    return { ok: true, value: unescapeString(body), valueType: "string" };
  }

  return {
    ok: false,
    error: `expected a quoted string, number, \`true\` or \`false\`, got \`${raw}\``,
  };
}

function unescapeString(body: string): string {
  return body.replace(/\\(["'\\nrt])/g, (_full, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return ch;
    }
  });
}

/**
 * Evaluate a parsed-or-raw condition against a context object.
 * Additive convenience for the engine; comparison is strict (`===` / `!==`).
 * Throws if the condition does not parse.
 */
export function evaluateEdgeCondition(
  condition: EdgeCondition,
  context: Record<string, unknown>,
): boolean {
  const parsed = parseEdgeCondition(condition);
  if (!parsed.ok) {
    throw new Error(`Invalid edge condition: ${parsed.error}`);
  }
  const actual = resolvePath(context, parsed.condition.path);
  return parsed.condition.operator === "=="
    ? actual === parsed.condition.value
    : actual !== parsed.condition.value;
}

function resolvePath(context: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = context;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Workflow validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Validate a workflow graph. Returns every problem found rather than throwing
 * on the first one, so the builder can render them all at once.
 */
export function validateWorkflow(
  workflow: Workflow,
  opts: ValidateWorkflowOptions = {},
): ValidationResult {
  const errors: ValidationError[] = [];
  const nodes: WorkflowNode[] = workflow?.nodes ?? [];
  const edges: WorkflowEdge[] = workflow?.edges ?? [];

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (nodesById.has(node.id)) {
      errors.push({
        code: VALIDATION_CODES.DUPLICATE_NODE_ID,
        message: `Duplicate node id "${node.id}".`,
        nodeId: node.id,
      });
      continue;
    }
    nodesById.set(node.id, node);
  }

  for (const node of nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) {
      errors.push({
        code: VALIDATION_CODES.INVALID_NODE_ID,
        message: `Node id "${node.id}" must match ${NODE_ID_PATTERN.source} (no whitespace) to be reportable by the progress channels.`,
        nodeId: node.id,
      });
    }
  }

  const seenEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      errors.push({
        code: VALIDATION_CODES.DUPLICATE_EDGE_ID,
        message: `Duplicate edge id "${edge.id}".`,
        edgeId: edge.id,
      });
      continue;
    }
    seenEdgeIds.add(edge.id);
  }

  // --- dangling edges -------------------------------------------------------
  const validEdges: WorkflowEdge[] = [];
  for (const edge of edges) {
    let dangling = false;
    if (!nodesById.has(edge.source)) {
      dangling = true;
      errors.push({
        code: VALIDATION_CODES.DANGLING_EDGE_SOURCE,
        message: `Edge "${edge.id}" references unknown source node "${edge.source}".`,
        edgeId: edge.id,
      });
    }
    if (!nodesById.has(edge.target)) {
      dangling = true;
      errors.push({
        code: VALIDATION_CODES.DANGLING_EDGE_TARGET,
        message: `Edge "${edge.id}" references unknown target node "${edge.target}".`,
        edgeId: edge.id,
      });
    }
    if (!dangling) validEdges.push(edge);
  }

  // --- edge conditions ------------------------------------------------------
  for (const edge of edges) {
    if (edge.condition === undefined) continue;
    const parsed = parseEdgeCondition(edge.condition);
    // A switcher's exit may say when it is taken in plain words (ANT-165).
    if (!parsed.ok && edge.kind !== "switch") {
      errors.push({
        code: VALIDATION_CODES.INVALID_EDGE_CONDITION,
        message: `Edge "${edge.id}" has an unsupported condition: ${parsed.error}.`,
        edgeId: edge.id,
      });
    }
  }

  // --- start node -----------------------------------------------------------
  const startNodes = [...nodesById.values()].filter(
    (node) => node.type === "start",
  );
  if (startNodes.length === 0) {
    errors.push({
      code: VALIDATION_CODES.NO_START_NODE,
      message: "Workflow must contain exactly one start node, found none.",
    });
  } else if (startNodes.length > 1) {
    errors.push({
      code: VALIDATION_CODES.MULTIPLE_START_NODES,
      message: `Workflow must contain exactly one start node, found ${
        startNodes.length
      }: ${startNodes.map((n) => `"${n.id}"`).join(", ")}.`,
    });
  }

  // --- adjacency ------------------------------------------------------------
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const id of nodesById.keys()) outgoing.set(id, []);
  for (const edge of validEdges) {
    outgoing.get(edge.source)!.push(edge);
  }

  // --- reachability ---------------------------------------------------------
  if (startNodes.length > 0) {
    const reachable = new Set<string>();
    const queue: string[] = startNodes.map((n) => n.id);
    for (const id of queue) reachable.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outgoing.get(current) ?? []) {
        if (!reachable.has(edge.target)) {
          reachable.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of nodesById.values()) {
      if (!reachable.has(node.id)) {
        errors.push({
          code: VALIDATION_CODES.UNREACHABLE_NODE,
          message: `Node "${node.id}" is not reachable from the start node.`,
          nodeId: node.id,
        });
      }
    }
  }

  // --- per-node rules -------------------------------------------------------
  for (const node of nodesById.values()) {
    if (node.type === "agent") {
      validateAgentNode(node, opts, errors);
    }

    if (node.type === "approval") {
      const out = outgoing.get(node.id) ?? [];
      if (out.length === 0) {
        errors.push({
          code: VALIDATION_CODES.APPROVAL_NODE_NO_OUTGOING_EDGE,
          message: `Approval node "${node.id}" has no outgoing edge, so an approved run has nowhere to resume.`,
          nodeId: node.id,
        });
      }
    }
  }

  // --- loop bounds ----------------------------------------------------------
  for (const cycle of findCycles(nodesById, outgoing)) {
    const bounded = cycle.some((id) => {
      const node = nodesById.get(id);
      return node ? hasRetryLimit(node) : false;
    });
    if (bounded) continue;
    const path = cycle.map((id) => `"${id}"`).join(" -> ");
    errors.push({
      code: VALIDATION_CODES.UNBOUNDED_LOOP,
      message: `Loop (${path}) is unbounded: at least one node in the cycle must set config.retryPolicy.maxAttempts.`,
      nodeId: cycle[0],
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateAgentNode(
  node: WorkflowNode,
  opts: ValidateWorkflowOptions,
  errors: ValidationError[],
): void {
  const config = (node.config ?? {}) as Record<string, unknown>;

  const role = config.role;
  if (!isNonEmptyString(role)) {
    errors.push({
      code: VALIDATION_CODES.AGENT_MISSING_ROLE,
      message: `Agent node "${node.id}" is missing a non-empty config.role.`,
      nodeId: node.id,
    });
  }

  const runtime = config.runtime;
  if (!isNonEmptyString(runtime)) {
    errors.push({
      code: VALIDATION_CODES.AGENT_MISSING_RUNTIME,
      message: `Agent node "${node.id}" is missing a non-empty config.runtime.`,
      nodeId: node.id,
    });
  } else if (opts.availableRuntimes && !opts.availableRuntimes.includes(runtime)) {
    errors.push({
      code: VALIDATION_CODES.UNKNOWN_RUNTIME,
      message: `Agent node "${node.id}" uses runtime "${runtime}", which is not available. Available runtimes: ${
        opts.availableRuntimes.length > 0
          ? opts.availableRuntimes.map((r) => `"${r}"`).join(", ")
          : "(none)"
      }.`,
      nodeId: node.id,
    });
  }

  if (!isNonEmptyString(config.instructions)) {
    errors.push({
      code: VALIDATION_CODES.AGENT_MISSING_INSTRUCTIONS,
      message: `Agent node "${node.id}" is missing non-empty config.instructions.`,
      nodeId: node.id,
    });
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRetryLimit(node: WorkflowNode): boolean {
  const retryPolicy = (node.config as Record<string, unknown> | undefined)
    ?.retryPolicy;
  if (retryPolicy === null || typeof retryPolicy !== "object") return false;
  const maxAttempts = (retryPolicy as Record<string, unknown>).maxAttempts;
  return typeof maxAttempts === "number" && Number.isFinite(maxAttempts);
}

/**
 * Find every cycle group in the graph, as strongly connected components
 * (Tarjan). An SCC with more than one node is a cycle; a single node is a
 * cycle only if it has a self-loop.
 */
function findCycles(
  nodesById: Map<string, WorkflowNode>,
  outgoing: Map<string, WorkflowEdge[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const selfLooped = new Set<string>();
  for (const edges of outgoing.values()) {
    for (const edge of edges) {
      if (edge.source === edge.target) selfLooped.add(edge.source);
    }
  }

  // Iterative Tarjan to stay safe on large graphs.
  for (const root of nodesById.keys()) {
    if (index.has(root)) continue;

    const work: Array<{ node: string; edgeIndex: number }> = [
      { node: root, edgeIndex: 0 },
    ];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = outgoing.get(frame.node) ?? [];

      if (frame.edgeIndex < edges.length) {
        const next = edges[frame.edgeIndex]!.target;
        frame.edgeIndex += 1;

        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edgeIndex: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, index.get(next)!),
          );
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
        );
      }

      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        component.reverse();
        if (component.length > 1 || selfLooped.has(component[0]!)) {
          components.push(component);
        }
      }
    }
  }

  return components;
}
