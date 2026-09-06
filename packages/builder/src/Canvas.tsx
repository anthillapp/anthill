/**
 * Canvas: the workflow graph editing surface.
 *
 * Controlled component: it renders the `workflow` it is given and reports every
 * edit through `onChange`. It owns no workflow state of its own and contains no
 * execution logic — every mutation goes through the pure `document.ts` helpers.
 *
 * NOTE: consumers must import React Flow's stylesheet once in their app entry:
 *   import "@xyflow/react/dist/style.css";
 * It is deliberately not imported here so this package stays consumable by
 * plain `tsc` builds without a CSS-aware bundler.
 */

import { useCallback, useMemo, type CSSProperties } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  Position as HandlePosition,
  ReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";

import type {
  EdgeAnchor,
  NodeType,
  ValidationResult,
  Workflow,
  WorkflowEdge,
} from "./contracts";
import {
  NODE_TYPE_LABELS,
  addEdge,
  canConnect,
  findNode,
  moveNode,
  nextEdgeId,
  removeEdge,
  removeNode,
  updateEdge,
} from "./document";

export type CanvasSelection = {
  nodeId: string | null;
  edgeId: string | null;
};

export type CanvasProps = {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  /** Optional validation result used to badge nodes with error counts. */
  validation?: ValidationResult;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectionChange?: (selection: CanvasSelection) => void;
  className?: string;
  style?: CSSProperties;
};

type AnthillNodeData = {
  label: string;
  nodeType: NodeType;
  errorCount: number;
};

type AnthillFlowNode = FlowNode<AnthillNodeData, "anthill">;

const NODE_COLORS: Record<NodeType, string> = {
  start: "#d3f9d8",
  agent: "#d0ebff",
  approval: "#ffec99",
  condition: "#e5dbff",
  command: "#e9ecef",
  end: "#ffd8d8",
};

/**
 * Every block carries a handle on all four sides.
 *
 * They are declared as `source` and the canvas runs in `ConnectionMode.Loose`,
 * which lets a single handle both start and receive a connection. That means
 * you can draw an edge from any side to any side — a loop can leave the bottom
 * and come back underneath instead of being forced right-to-left across the
 * forward edges. Which side an edge uses is persisted on the edge, so a diagram
 * reopens looking the way it was drawn.
 *
 * Direction rules (no edge into `start`, none out of `end`, no self-loops) are
 * enforced in `isValidConnection` rather than by omitting handles, so the
 * refusal is visible while dragging instead of the handle simply not existing.
 */
const HANDLE_POSITIONS: { id: EdgeAnchor; position: HandlePosition }[] = [
  { id: "top", position: HandlePosition.Top },
  { id: "right", position: HandlePosition.Right },
  { id: "bottom", position: HandlePosition.Bottom },
  { id: "left", position: HandlePosition.Left },
];

const HANDLE_STYLE: CSSProperties = {
  width: 11,
  height: 11,
  background: "#fff",
  border: "2px solid #868e96",
  borderRadius: "50%",
};

function WorkflowNodeView({ data, selected }: NodeProps<AnthillFlowNode>) {
  const hasErrors = data.errorCount > 0;
  return (
    <div
      data-testid={`canvas-node-${data.nodeType}`}
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        border: `${selected ? 2 : 1}px solid ${hasErrors ? "#e03131" : "#495057"}`,
        background: NODE_COLORS[data.nodeType],
        minWidth: 150,
        fontSize: 12,
      }}
    >
      {HANDLE_POSITIONS.map(({ id, position }) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          style={HANDLE_STYLE}
        />
      ))}
      <div style={{ textTransform: "uppercase", opacity: 0.7 }}>
        {NODE_TYPE_LABELS[data.nodeType]}
      </div>
      <div style={{ fontWeight: 600 }}>{data.label}</div>
      {hasErrors && (
        <div style={{ color: "#e03131" }}>
          {data.errorCount} issue{data.errorCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// Must be module-level: a new object identity on every render makes React Flow
// re-mount every node.
const nodeTypes: NodeTypes = { anthill: WorkflowNodeView };

const DEFAULT_STYLE: CSSProperties = { width: "100%", height: "100%" };

export function Canvas({
  workflow,
  onChange,
  validation,
  selectedNodeId = null,
  selectedEdgeId = null,
  onSelectionChange,
  className,
  style,
}: CanvasProps) {
  const flowNodes = useMemo<AnthillFlowNode[]>(
    () =>
      workflow.nodes.map((node) => ({
        id: node.id,
        type: "anthill" as const,
        position: node.position ?? { x: 0, y: 0 },
        selected: node.id === selectedNodeId,
        data: {
          label: node.name,
          nodeType: node.type,
          errorCount:
            validation?.errors.filter((error) => error.nodeId === node.id)
              .length ?? 0,
        },
      })),
    [workflow.nodes, selectedNodeId, validation],
  );

  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      workflow.edges.map((edge) => {
        const isSelected = edge.id === selectedEdgeId;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          // An edge with no recorded side keeps the old left-to-right look.
          // Without an explicit choice React Flow would pick the first handle
          // declared on the node, which sends every unanchored edge over the top.
          sourceHandle: edge.sourceHandle ?? "right",
          targetHandle: edge.targetHandle ?? "left",
          label: edge.label,
          selected: isSelected,
          // Right-angle routing keeps a loop that leaves the bottom of a block
          // clear of the forward edges instead of cutting through them.
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          style: { strokeWidth: isSelected ? 2.5 : 1.5 },
          // Widen the invisible click target; the visible line stays thin.
          interactionWidth: 24,
        };
      }),
    [workflow.edges, selectedEdgeId],
  );

  // Selection is prop-driven (the `selected` flag above), so React Flow reports
  // clicks as `select` changes and expects us to apply them.
  const applySelectChange = useCallback(
    (id: string, selected: boolean, kind: "node" | "edge") => {
      if (!onSelectionChange) return;
      if (selected) {
        onSelectionChange(
          kind === "node"
            ? { nodeId: id, edgeId: null }
            : { nodeId: null, edgeId: id },
        );
      } else if (
        (kind === "node" && selectedNodeId === id) ||
        (kind === "edge" && selectedEdgeId === id)
      ) {
        onSelectionChange({ nodeId: null, edgeId: null });
      }
    },
    [onSelectionChange, selectedNodeId, selectedEdgeId],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<AnthillFlowNode>[]) => {
      let next = workflow;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          if (findNode(next, change.id)) {
            next = moveNode(next, change.id, change.position);
          }
        } else if (change.type === "remove") {
          next = removeNode(next, change.id);
          if (selectedNodeId === change.id) {
            onSelectionChange?.({ nodeId: null, edgeId: null });
          }
        } else if (change.type === "select") {
          applySelectChange(change.id, change.selected, "node");
        }
      }
      if (next !== workflow) onChange(next);
    },
    [workflow, onChange, applySelectChange, onSelectionChange, selectedNodeId],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      let next = workflow;
      for (const change of changes) {
        if (change.type === "remove") {
          next = removeEdge(next, change.id);
          if (selectedEdgeId === change.id) {
            onSelectionChange?.({ nodeId: null, edgeId: null });
          }
        } else if (change.type === "select") {
          applySelectChange(change.id, change.selected, "edge");
        }
      }
      if (next !== workflow) onChange(next);
    },
    [workflow, onChange, applySelectChange, onSelectionChange, selectedEdgeId],
  );

  const asAnchor = (handle: string | null | undefined): EdgeAnchor | undefined =>
    handle === "top" || handle === "right" || handle === "bottom" || handle === "left"
      ? handle
      : undefined;

  // React Flow calls this while dragging, so an illegal drop is refused under
  // the cursor rather than silently discarded. The rule itself lives in
  // `document.ts` because it is about the document, not the rendering.
  const isValidConnection = useCallback(
    (connection: Connection | FlowEdge) =>
      canConnect(workflow, {
        source: connection.source,
        target: connection.target,
        sourceHandle: asAnchor(connection.sourceHandle),
        targetHandle: asAnchor(connection.targetHandle),
        edgeId: "id" in connection ? connection.id : undefined,
      }),
    [workflow],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;
      const edge: WorkflowEdge = {
        id: nextEdgeId(workflow),
        source: connection.source,
        target: connection.target,
        sourceHandle: asAnchor(connection.sourceHandle),
        targetHandle: asAnchor(connection.targetHandle),
      };
      onChange(addEdge(workflow, edge));
    },
    [workflow, onChange, isValidConnection],
  );

  /** Dragging an existing endpoint onto another handle re-routes that edge. */
  const handleReconnect = useCallback(
    (previous: FlowEdge, connection: Connection) => {
      if (!isValidConnection({ ...connection, id: previous.id } as FlowEdge)) return;
      onChange(
        updateEdge(workflow, previous.id, {
          source: connection.source,
          target: connection.target,
          sourceHandle: asAnchor(connection.sourceHandle),
          targetHandle: asAnchor(connection.targetHandle),
        }),
      );
    },
    [workflow, onChange, isValidConnection],
  );

  return (
    <div
      data-testid="workflow-canvas"
      className={className}
      style={{ ...DEFAULT_STYLE, ...style }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={30}
        reconnectRadius={14}
        deleteKeyCode={["Delete", "Backspace"]}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export default Canvas;
