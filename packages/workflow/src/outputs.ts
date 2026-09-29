/**
 * Block outputs.
 *
 * A block's outputs are what leaves it: each has a kind, a label, an optional
 * condition, and a target it leads to. Previously a connection was only
 * "an edge with a condition"; making it an output of the block gives the author
 * something to add, name and route before it goes anywhere.
 *
 * Storage, deliberately split:
 *
 * - A **connected** output is a `WorkflowEdge`. `kind` and `anchor` were added
 *   to the shared schema because they are edge semantics and presentation, the
 *   same category as `label` and `position`.
 * - An **unconnected** output has no edge to be — `WorkflowEdge.target` is
 *   required, and loosening it would reach into the model the future runner
 *   shares. It lives in `node.config.pendingOutputs` instead, which is where
 *   Workflow-only concerns already live.
 *
 * Callers see one ordered list either way; `outputsOf` merges them.
 */

import type {
  EdgeAnchor,
  EdgeAnchorPoint,
  EdgeBend,
  EdgeRouting,
  OutcomeKind,
  Workflow,
  WorkflowEdge,
} from "@anthill/workflow-schema";

export type BlockOutput = {
  id: string;
  label: string;
  kind: OutcomeKind;
  condition?: string;
  /** `null` while the author has not said where it goes. */
  target: string | null;
  /** Exact landing point on the target block, in fractions of its box. */
  anchor?: EdgeAnchorPoint;
  /** Where the author put the port, if they moved it off the right edge. */
  port?: EdgeAnchorPoint;
  /** How the line is drawn. `curved` when unset. */
  routing?: EdgeRouting;
  /** The author's adjustment to the line's shape. */
  bend?: EdgeBend;
};

/** What an unconnected output looks like in `node.config.pendingOutputs`. */
type PendingOutput = {
  id: string;
  label?: string;
  kind?: OutcomeKind;
  condition?: string;
  /**
   * An unconnected output has a port like any other, and the author may have
   * moved it, so its placement is kept here too.
   */
  port?: EdgeAnchorPoint;
  routing?: EdgeRouting;
  bend?: EdgeBend;
};

export const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  next: "Next",
  rework: "Rework",
  question: "Question",
  stop: "Stop",
  switch: "Switch",
};

/** What each kind means, shown next to the picker so the choice is informed. */
export const OUTCOME_MEANINGS: Record<OutcomeKind, string> = {
  next: "The step was accepted; the workflow moves on.",
  rework: "The work was not accepted and goes back to be redone.",
  question: "Someone else has to answer before the workflow can continue.",
  stop: "This path ends here.",
  switch: "One of several paths; the agent takes exactly one of them, once.",
};

export const DEFAULT_OUTCOME_KIND: OutcomeKind = "next";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPending(node: { config: Record<string, unknown> }): PendingOutput[] {
  const raw = node.config.pendingOutputs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((item) => {
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) return [];
    return [
      {
        id,
        label: typeof item.label === "string" ? item.label : undefined,
        kind: isOutcomeKind(item.kind) ? item.kind : undefined,
        condition: typeof item.condition === "string" ? item.condition : undefined,
        port: readAnchorPoint(item.port),
        routing: isEdgeRouting(item.routing) ? item.routing : undefined,
        bend: readBend(item.bend),
      },
    ];
  });
}

function readAnchorPoint(value: unknown): EdgeAnchorPoint | undefined {
  if (!isRecord(value)) return undefined;
  const { u, v } = value;
  if (typeof u !== "number" || typeof v !== "number") return undefined;
  return { u, v };
}

function readBend(value: unknown): EdgeBend | undefined {
  if (!isRecord(value)) return undefined;
  const { along, across } = value;
  if (typeof along !== "number" || typeof across !== "number") return undefined;
  return { along, across };
}

export function isEdgeRouting(value: unknown): value is EdgeRouting {
  return value === "curved" || value === "orthogonal";
}

export function isOutcomeKind(value: unknown): value is OutcomeKind {
  return (
    value === "next" ||
    value === "rework" ||
    value === "question" ||
    value === "stop" ||
    value === "switch"
  );
}

/**
 * A point on the side a handle names, in fractions of the block.
 *
 * Not the middle: a template's loop can leave one side of a block that another
 * connection arrives at (Implement, test, fix leaves Run tests from the bottom
 * and comes back into its bottom), and a port drawn on an arrowhead reads as
 * neither. Leaving at two thirds along and arriving at one third keeps them
 * apart, and keeps a pair of opposite connections from crossing.
 */
function handlePoint(handle: EdgeAnchor | undefined, end: "leave" | "arrive"): EdgeAnchorPoint | undefined {
  if (!handle) return undefined;
  const along = end === "leave" ? 0.65 : 0.35;
  switch (handle) {
    case "top":
      return { u: along, v: 0 };
    case "bottom":
      return { u: along, v: 1 };
    case "left":
      return { u: 0, v: along };
    case "right":
      return { u: 1, v: along };
  }
}

/*
  A connection may say only which side it leaves from and arrives at
  (`sourceHandle`, `targetHandle`), as the templates' rework loops do. Those
  sides were never read, so a loop meant to run under the row was routed along
  it instead: from the step it leaves, straight through the step it returns
  to, and hidden behind that step (ANT-194). A point on the named side
  stands in when no exact point was placed. A port or landing point the author
  placed by hand still wins.
*/
function edgeToOutput(edge: WorkflowEdge): BlockOutput {
  return {
    id: edge.id,
    label: edge.label ?? "",
    kind: edge.kind ?? DEFAULT_OUTCOME_KIND,
    condition: edge.condition,
    target: edge.target,
    anchor: edge.anchor ?? handlePoint(edge.targetHandle, "arrive"),
    port: edge.port ?? handlePoint(edge.sourceHandle, "leave"),
    routing: edge.routing,
    bend: edge.bend,
  };
}

/**
 * The outputs of one block, in port order.
 *
 * Connected outputs come first, in edge order, then those not yet routed. Port
 * positions are derived from this order, so it has to be stable.
 */
export function outputsOf(workflow: Workflow, nodeId: string): BlockOutput[] {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  const connected = workflow.edges
    .filter((edge) => edge.source === nodeId)
    .map(edgeToOutput);

  if (!node) return connected;

  const pending = readPending(node).map<BlockOutput>((item) => ({
    id: item.id,
    label: item.label ?? "",
    kind: item.kind ?? DEFAULT_OUTCOME_KIND,
    condition: item.condition,
    target: null,
    port: item.port,
    routing: item.routing,
    bend: item.bend,
  }));

  return [...connected, ...pending];
}

/** Every output in the workflow, keyed by the block it leaves. */
export function allOutputs(workflow: Workflow): Record<string, BlockOutput[]> {
  const result: Record<string, BlockOutput[]> = {};
  for (const node of workflow.nodes) result[node.id] = outputsOf(workflow, node.id);
  return result;
}

/** Find one output anywhere in the workflow. */
export function findOutput(
  workflow: Workflow,
  nodeId: string,
  outputId: string,
): BlockOutput | undefined {
  return outputsOf(workflow, nodeId).find((output) => output.id === outputId);
}

function nextOutputId(workflow: Workflow): string {
  const taken = new Set<string>();
  for (const edge of workflow.edges) taken.add(edge.id);
  for (const node of workflow.nodes) {
    for (const pending of readPending(node)) taken.add(pending.id);
  }
  for (let index = 1; ; index += 1) {
    const candidate = `out-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function withPending(
  workflow: Workflow,
  nodeId: string,
  update: (current: PendingOutput[]) => PendingOutput[],
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const next = update(readPending(node));
      const config = { ...node.config };
      if (next.length === 0) delete config.pendingOutputs;
      else config.pendingOutputs = next;
      return { ...node, config };
    }),
  };
}

export type AddOutputResult = { workflow: Workflow; outputId: string };

/**
 * Add an output to a block. It starts unconnected — the author routes it next,
 * which is why the canvas drops straight into linking mode after this.
 */
export function addOutput(
  workflow: Workflow,
  nodeId: string,
  kind: OutcomeKind = DEFAULT_OUTCOME_KIND,
  label = "",
): AddOutputResult {
  const outputId = nextOutputId(workflow);
  return {
    workflow: withPending(workflow, nodeId, (current) => [
      ...current,
      { id: outputId, kind, label },
    ]),
    outputId,
  };
}

export type OutputPatch = {
  label?: string;
  kind?: OutcomeKind;
  /** `undefined` clears the condition. */
  condition?: string | undefined;
  /** `null` puts the port back on the block's right edge. */
  port?: EdgeAnchorPoint | null;
  /**
   * Where the arrow lands on its target. Only a connected output has one, so
   * this is ignored for an output that is not routed yet.
   */
  anchor?: EdgeAnchorPoint | null;
  routing?: EdgeRouting;
  /** `null` puts the line back to the shape it takes on its own. */
  bend?: EdgeBend | null;
};

/**
 * Apply a patch to whichever record the output lives in.
 *
 * An edge and a pending output carry the same fields, so the same rules apply
 * to both: an absent key leaves the field alone, and an explicit `undefined`
 * or `null` clears it. Written once rather than twice, so the two storage
 * locations cannot drift apart.
 */
type OutputAppearance = {
  label?: string;
  kind?: OutcomeKind;
  condition?: string;
  port?: EdgeAnchorPoint;
  routing?: EdgeRouting;
  bend?: EdgeBend;
};

function applyPatch<T extends OutputAppearance>(item: T, patch: OutputPatch): T {
  // Written through the shared shape and cast back: TypeScript cannot prove a
  // write to a generic is sound, and the fields are identical in both records.
  const next = { ...item } as OutputAppearance;
  if (patch.label !== undefined) next.label = patch.label || undefined;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if ("condition" in patch) {
    if (patch.condition === undefined) delete next.condition;
    else next.condition = patch.condition;
  }
  if ("port" in patch) {
    if (patch.port === null || patch.port === undefined) delete next.port;
    else next.port = patch.port;
  }
  if (patch.routing !== undefined) next.routing = patch.routing;
  if ("bend" in patch) {
    if (patch.bend === null || patch.bend === undefined) delete next.bend;
    else next.bend = patch.bend;
  }
  return next as T;
}

/** Change an output's label, kind, condition or appearance, wherever it is stored. */
export function patchOutput(
  workflow: Workflow,
  nodeId: string,
  outputId: string,
  patch: OutputPatch,
): Workflow {
  const edge = workflow.edges.find(
    (item) => item.id === outputId && item.source === nodeId,
  );

  if (edge) {
    return {
      ...workflow,
      edges: workflow.edges.map((item) => {
        if (item.id !== outputId) return item;
        const updated = applyPatch(item, patch);
        // A port or landing set, or put back, replaces the side a template
        // named for it: otherwise putting a port back on the right edge would
        // leave it on the named side instead (ANT-194).
        if ("port" in patch) delete updated.sourceHandle;
        if ("anchor" in patch) {
          delete updated.targetHandle;
          if (patch.anchor === null || patch.anchor === undefined) delete updated.anchor;
          else updated.anchor = patch.anchor;
        }
        return updated;
      }),
    };
  }

  return withPending(workflow, nodeId, (current) =>
    current.map((item) => (item.id === outputId ? applyPatch(item, patch) : item)),
  );
}

/** Remove an output and, if it was connected, the connection with it. */
export function removeOutput(
  workflow: Workflow,
  nodeId: string,
  outputId: string,
): Workflow {
  const withoutEdge: Workflow = {
    ...workflow,
    edges: workflow.edges.filter(
      (edge) => !(edge.id === outputId && edge.source === nodeId),
    ),
  };
  return withPending(withoutEdge, nodeId, (current) =>
    current.filter((item) => item.id !== outputId),
  );
}

/**
 * Point an output at a block, or disconnect it.
 *
 * Connecting moves the output out of the pending list and into an edge, keeping
 * its id so anything selecting it stays selected. Disconnecting moves it back
 * and drops the anchor, since the anchor belonged to a target that is gone.
 */
export function setOutputTarget(
  workflow: Workflow,
  nodeId: string,
  outputId: string,
  target: string | null,
  anchor?: EdgeAnchorPoint | null,
): Workflow {
  const output = findOutput(workflow, nodeId, outputId);
  if (!output) return workflow;

  if (target === null) {
    const detached = removeOutput(workflow, nodeId, outputId);
    return withPending(detached, nodeId, (current) => [
      ...current,
      {
        id: outputId,
        label: output.label || undefined,
        kind: output.kind,
        condition: output.condition,
        // The anchor belonged to a target that is gone; the port and the line's
        // shape belong to this block, so they survive being detached.
        port: output.port,
        routing: output.routing,
        bend: output.bend,
      },
    ]);
  }

  const existing = workflow.edges.find(
    (edge) => edge.id === outputId && edge.source === nodeId,
  );

  if (existing) {
    return {
      ...workflow,
      edges: workflow.edges.map((edge) => {
        if (edge.id !== outputId) return edge;
        const next: WorkflowEdge = { ...edge, target };
        // The side it arrived at belonged to the old target.
        if (target !== edge.target) delete next.targetHandle;
        if (anchor === null) delete next.anchor;
        else if (anchor) next.anchor = anchor;
        return next;
      }),
    };
  }

  const edge: WorkflowEdge = {
    id: outputId,
    source: nodeId,
    target,
    kind: output.kind,
    ...(output.label ? { label: output.label } : {}),
    ...(output.condition ? { condition: output.condition } : {}),
    ...(anchor ? { anchor } : {}),
    ...(output.port ? { port: output.port } : {}),
    ...(output.routing ? { routing: output.routing } : {}),
    ...(output.bend ? { bend: output.bend } : {}),
  };

  const cleared = withPending(workflow, nodeId, (current) =>
    current.filter((item) => item.id !== outputId),
  );
  return { ...cleared, edges: [...cleared.edges, edge] };
}

/** Outputs the author has added but not yet routed. */
export function unconnectedOutputs(
  workflow: Workflow,
): { nodeId: string; output: BlockOutput }[] {
  const result: { nodeId: string; output: BlockOutput }[] = [];
  for (const node of workflow.nodes) {
    for (const output of outputsOf(workflow, node.id)) {
      if (output.target === null) result.push({ nodeId: node.id, output });
    }
  }
  return result;
}

/*
  A switcher (ANT-165): two or more connected `switch` exits on one block. The
  agent takes exactly one of them, once, so they read as one path that splits
  rather than as several arrows that happen to start at the same block. Only
  connected exits count — an exit still being routed is not yet a choice.
*/

/** The block's connected `switch` exits, in port order. */
export function switchExits(workflow: Workflow, nodeId: string): BlockOutput[] {
  return outputsOf(workflow, nodeId).filter(
    (output) => output.kind === "switch" && output.target !== null,
  );
}

/** Whether a block's exits form a switcher: two or more connected `switch` exits. */
export function isSwitcher(exits: readonly BlockOutput[]): boolean {
  return exits.filter((output) => output.kind === "switch" && output.target !== null).length >= 2;
}

export const SWITCHER_NOTE =
  "These exits form a switcher: the agent takes exactly one, once. Put the one without a condition last — it is the otherwise path.";

/**
 * What breaks "exactly one" among a switcher's exits, if anything.
 *
 * Checked in order: each exit's condition is tried in turn and the one with
 * none is the otherwise path. Two without a condition leave the choice
 * undecided; one without a condition ahead of the others shadows everything
 * after it.
 */
export function switcherProblem(exits: readonly BlockOutput[]): string | undefined {
  const switches = exits.filter((output) => output.kind === "switch" && output.target !== null);
  if (switches.length < 2) return undefined;
  const open = switches.filter((output) => !output.condition?.trim());
  if (open.length > 1) return "Two exits have no condition — only one can be the otherwise path.";
  if (open.length === 1 && switches[switches.length - 1] !== open[0]) {
    return "The otherwise exit must be the last one.";
  }
  return undefined;
}
