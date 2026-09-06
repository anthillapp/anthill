/**
 * WorkflowDocument: pure, framework-agnostic edit operations over a `Workflow`.
 *
 * Rules that hold for every operation in this module:
 * - The input workflow is never mutated.
 * - A successful edit returns a NEW workflow object (and new arrays for the
 *   collections it touched); untouched nodes/edges keep their identity.
 * - A no-op (e.g. removing something that does not exist) returns the input
 *   workflow unchanged, by reference.
 * - Programmer errors (duplicate ids, unknown ids on an update) throw.
 *
 * This layer contains NO execution logic. It only edits workflow definitions.
 */

import { nextIdFor, rememberIds } from "@anthill/workflow";

import type {
  EdgeAnchor,
  NodeType,
  Position,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./contracts";

export class WorkflowDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDocumentError";
  }
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function findNode(
  doc: Workflow,
  nodeId: string,
): WorkflowNode | undefined {
  return doc.nodes.find((node) => node.id === nodeId);
}

export function findEdge(
  doc: Workflow,
  edgeId: string,
): WorkflowEdge | undefined {
  return doc.edges.find((edge) => edge.id === edgeId);
}

export function outgoingEdges(doc: Workflow, nodeId: string): WorkflowEdge[] {
  return doc.edges.filter((edge) => edge.source === nodeId);
}

export function incomingEdges(doc: Workflow, nodeId: string): WorkflowEdge[] {
  return doc.edges.filter((edge) => edge.target === nodeId);
}

/* ------------------------------------------------------------------ */
/* Node operations                                                     */
/* ------------------------------------------------------------------ */

/** Appends a node. Throws if the id is empty or already used. */
export function addNode(doc: Workflow, node: WorkflowNode): Workflow {
  if (!node.id) {
    throw new WorkflowDocumentError("Cannot add a node without an id");
  }
  if (findNode(doc, node.id)) {
    throw new WorkflowDocumentError(`Node id "${node.id}" already exists`);
  }
  // Remembered here rather than where the id was minted, so an id that came
  // from a template or a draft is kept out of circulation on the same terms.
  return rememberIds({ ...doc, nodes: [...doc.nodes, node] }, node.id);
}

/**
 * Removes a node and every edge that touches it (structural integrity is kept
 * here rather than deferred to validation). Unknown ids are a no-op.
 */
export function removeNode(doc: Workflow, nodeId: string): Workflow {
  if (!findNode(doc, nodeId)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => node.id !== nodeId),
    edges: doc.edges.filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId,
    ),
  };
}

/**
 * Shallow-merges `config` into the node's existing config.
 * A key set to `undefined` is removed from the config.
 * Throws if the node does not exist.
 */
export function updateNodeConfig(
  doc: Workflow,
  nodeId: string,
  config: Record<string, unknown>,
): Workflow {
  return mapNode(doc, nodeId, (node) => {
    const next: Record<string, unknown> = { ...node.config };
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return { ...node, config: next };
  });
}

/** Sets a node's canvas position. Throws if the node does not exist. */
export function moveNode(
  doc: Workflow,
  nodeId: string,
  position: Position,
): Workflow {
  return mapNode(doc, nodeId, (node) => ({
    ...node,
    position: { x: position.x, y: position.y },
  }));
}

/**
 * Renames a node (`name` is a top-level field, not part of `config`).
 * Not part of the original operation list, but the property panel needs it.
 */
export function renameNode(
  doc: Workflow,
  nodeId: string,
  name: string,
): Workflow {
  return mapNode(doc, nodeId, (node) => ({ ...node, name }));
}

/* ------------------------------------------------------------------ */
/* Edge operations                                                     */
/* ------------------------------------------------------------------ */

/**
 * Adds an edge. Throws on an empty/duplicate id or on endpoints that are not
 * nodes of this workflow (no dangling edges can be introduced through the
 * document API). Parallel edges between the same pair are allowed: conditional
 * branches legitimately fan out to the same target with different labels.
 * Self-loops are allowed: feedback loops are first-class in the model.
 */
export function addEdge(doc: Workflow, edge: WorkflowEdge): Workflow {
  if (!edge.id) {
    throw new WorkflowDocumentError("Cannot add an edge without an id");
  }
  if (findEdge(doc, edge.id)) {
    throw new WorkflowDocumentError(`Edge id "${edge.id}" already exists`);
  }
  assertNodeExists(doc, edge.source, "source");
  assertNodeExists(doc, edge.target, "target");
  return rememberIds({ ...doc, edges: [...doc.edges, edge] }, edge.id);
}

/** Removes an edge. Unknown ids are a no-op. */
export function removeEdge(doc: Workflow, edgeId: string): Workflow {
  if (!findEdge(doc, edgeId)) return doc;
  return { ...doc, edges: doc.edges.filter((edge) => edge.id !== edgeId) };
}

/** A proposed connection, as reported by the canvas while dragging. */
export type ProposedConnection = {
  source: string | null;
  target: string | null;
  sourceHandle?: EdgeAnchor | null;
  targetHandle?: EdgeAnchor | null;
  /** Set when an existing edge is being re-routed, so it does not block itself. */
  edgeId?: string;
};

/**
 * Whether a connection may be drawn.
 *
 * Kept here rather than in the canvas because these are rules about the
 * document, not about rendering — and because a pure function can be tested
 * directly, which handle-dragging in jsdom cannot.
 *
 * Several edges may share the same pair of blocks (two different conditions can
 * both lead back to the developer), but not the same pair of *sides*: those
 * would stack invisibly on top of one another.
 */
export function canConnect(
  doc: Workflow,
  connection: ProposedConnection,
): boolean {
  const { source, target } = connection;
  if (!source || !target) return false;
  if (source === target) return false;

  const sourceNode = findNode(doc, source);
  const targetNode = findNode(doc, target);
  if (!sourceNode || !targetNode) return false;

  // Direction rules: nothing flows into the start, nothing leaves the end.
  if (targetNode.type === "start") return false;
  if (sourceNode.type === "end") return false;

  const sourceHandle = connection.sourceHandle ?? undefined;
  const targetHandle = connection.targetHandle ?? undefined;
  return !doc.edges.some(
    (edge) =>
      edge.id !== connection.edgeId &&
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? undefined) === sourceHandle &&
      (edge.targetHandle ?? undefined) === targetHandle,
  );
}

export type EdgePatch = Partial<Omit<WorkflowEdge, "id">>;

/**
 * Patches an edge's `source`, `target`, `condition`, `label` or handles.
 * Optional fields set to `undefined` are cleared.
 * Throws if the edge is unknown or a patched endpoint is not a node.
 */
export function updateEdge(
  doc: Workflow,
  edgeId: string,
  patch: EdgePatch,
): Workflow {
  const edge = findEdge(doc, edgeId);
  if (!edge) {
    throw new WorkflowDocumentError(`Unknown edge "${edgeId}"`);
  }
  if (patch.source !== undefined) assertNodeExists(doc, patch.source, "source");
  if (patch.target !== undefined) assertNodeExists(doc, patch.target, "target");

  const next: WorkflowEdge = { ...edge };
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.target !== undefined) next.target = patch.target;
  if ("condition" in patch) {
    if (patch.condition === undefined) delete next.condition;
    else next.condition = patch.condition;
  }
  if ("label" in patch) {
    if (patch.label === undefined) delete next.label;
    else next.label = patch.label;
  }
  if ("sourceHandle" in patch) {
    if (patch.sourceHandle === undefined) delete next.sourceHandle;
    else next.sourceHandle = patch.sourceHandle;
  }
  if ("targetHandle" in patch) {
    if (patch.targetHandle === undefined) delete next.targetHandle;
    else next.targetHandle = patch.targetHandle;
  }

  return {
    ...doc,
    edges: doc.edges.map((candidate) =>
      candidate.id === edgeId ? next : candidate,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Factories / id helpers                                              */
/* ------------------------------------------------------------------ */

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  start: "Start",
  agent: "Agent",
  approval: "Approval",
  condition: "Condition",
  command: "Command",
  end: "End",
};

/** Default `config` for a freshly created node of the given type. */
export function defaultConfigForType(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "agent":
      return {
        role: "",
        runtime: "",
        model: "",
        instructions: "",
        workingDirectory: "",
        successCriteria: "",
      };
    case "condition":
      return { expression: "" };
    case "command":
      return { command: "" };
    case "approval":
      return { prompt: "" };
    default:
      return {};
  }
}

/**
 * A `<type>-<n>` id this workflow has never used.
 *
 * Never used, not merely unused: the lowest free number handed a deleted
 * block's id to the next one created, and that id is what a running session
 * prints back at Anthill (ANT-41).
 */
export function nextNodeId(doc: Workflow, type: NodeType): string {
  return nextIdFor(
    doc,
    type,
    doc.nodes.map((node) => node.id),
  );
}

/** An `edge-<n>` id this workflow has never used. */
export function nextEdgeId(doc: Workflow): string {
  return nextIdFor(
    doc,
    "edge",
    doc.edges.map((edge) => edge.id),
  );
}

/** Builds a node with a unique id and sensible defaults for its type. */
export function createNode(
  doc: Workflow,
  type: NodeType,
  overrides: Partial<Omit<WorkflowNode, "type">> = {},
): WorkflowNode {
  const id = overrides.id ?? nextNodeId(doc, type);
  return {
    id,
    type,
    name: overrides.name ?? NODE_TYPE_LABELS[type],
    config: overrides.config ?? defaultConfigForType(type),
    position: overrides.position ?? { x: 0, y: 0 },
  };
}

export function createEmptyWorkflow(
  overrides: Partial<Workflow> = {},
): Workflow {
  return {
    id: "workflow",
    name: "Untitled workflow",
    version: "0.1.0",
    nodes: [],
    edges: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function mapNode(
  doc: Workflow,
  nodeId: string,
  update: (node: WorkflowNode) => WorkflowNode,
): Workflow {
  const node = findNode(doc, nodeId);
  if (!node) {
    throw new WorkflowDocumentError(`Unknown node "${nodeId}"`);
  }
  return {
    ...doc,
    nodes: doc.nodes.map((candidate) =>
      candidate.id === nodeId ? update(candidate) : candidate,
    ),
  };
}

function assertNodeExists(
  doc: Workflow,
  nodeId: string,
  role: "source" | "target",
): void {
  if (!findNode(doc, nodeId)) {
    throw new WorkflowDocumentError(
      `Edge ${role} "${nodeId}" is not a node in this workflow`,
    );
  }
}


