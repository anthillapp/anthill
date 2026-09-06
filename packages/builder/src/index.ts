/**
 * `@anthill/builder` — the visual workflow builder.
 *
 * Authoring only: this package creates and edits workflow DEFINITIONS. It
 * contains no execution logic.
 *
 * Consumers must import React Flow's stylesheet once in their app entry:
 *   import "@xyflow/react/dist/style.css";
 */

export const PACKAGE_NAME = "@anthill/builder";

/* Contracts — local mirror of `@anthill/workflow-schema`; re-export so the
   swap to the real package is a one-file change (see contracts.ts). */
export type {
  AgentNodeConfig,
  EdgeAnchor,
  NodeType,
  Position,
  ValidationError,
  ValidationResult,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./contracts";
export { NODE_TYPES } from "./contracts";

/* Document: pure workflow edit operations. */
export {
  NODE_TYPE_LABELS,
  WorkflowDocumentError,
  addEdge,
  addNode,
  canConnect,
  createEmptyWorkflow,
  createNode,
  defaultConfigForType,
  findEdge,
  findNode,
  incomingEdges,
  moveNode,
  nextEdgeId,
  nextNodeId,
  outgoingEdges,
  removeEdge,
  removeNode,
  renameNode,
  updateEdge,
  updateNodeConfig,
  type EdgePatch,
  type ProposedConnection,
} from "./document";

/* Validation: local structural subset used by the canvas. */
export {
  ValidationCode,
  errorsForEdge,
  errorsForNode,
  validate,
  type ValidationCodeValue,
} from "./validate";

/* Arrow geometry: pure, testable, no React. */
export {
  BEND_LIMIT,
  ELBOW_STUB,
  PORT_OFFSET,
  PORT_SPACING,
  UNCONNECTED_LABEL_OFFSET,
  UNCONNECTED_STUB_LENGTH,
  anchorFromPoint,
  bendFromPoint,
  curve,
  elbow,
  entryPoint,
  labelHalfSize,
  labelSpot,
  outward,
  portFromAnchor,
  portPoint,
  projectToSide,
  route,
  unconnectedStub,
  type AnchorPoint,
  type Bend,
  type CurveGeometry,
  type EntryPoint,
  type Point,
  type PortPoint,
  type Rect,
  type Routing,
  type Side,
} from "./geometry";

/* Trackpad zoom, shared by every canvas so they cannot drift apart. */
export {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  applyWheel,
  clampScale,
  isCanvasGesture,
  readWheel,
  zoomAbout,
  type ContainerBox,
  type Focal,
  type WheelIntent,
  type WheelLike,
  type ZoomView,
} from "./canvas-zoom";
export { useWheelZoom } from "./use-wheel-zoom";

/* Tidying up ports and arrowheads. */
export { centerOutputs, type CenterScope } from "./align";
export { assemblyPlan, type AssemblyPlan } from "./assembly";

/* Placing a generated workflow. Never applied to one the author has arranged. */
export {
  countCrossings,
  layoutWorkflow,
  splitBackEdges,
  withLayout,
  type LayoutOptions,
} from "./layout";

/* React surface. */
export { WorkflowBuilder, type WorkflowBuilderProps } from "./WorkflowBuilder";
export { Canvas, type CanvasProps, type CanvasSelection } from "./Canvas";
export {
  NO_SELECTION,
  WorkflowCanvas,
  type LinkingState,
  type WorkflowCanvasProps,
  type WorkflowSelection,
} from "./WorkflowCanvas";
export {
  CATEGORY_COLORS,
  GRID,
  OUTCOME_STYLES,
  PILL_SIZE,
  STEP_SIZE,
  blockColor,
  blockRect,
  buildCanvasModel,
  dropPosition,
  snapToGrid,
  type CanvasModel,
} from "./workflow-canvas-model";
export {
  NodePalette,
  defaultPositionFor,
  type NodePaletteProps,
} from "./NodePalette";
export {
  NodePropertyPanel,
  type NodePropertyPanelProps,
} from "./NodePropertyPanel";
export { ValidationPanel, type ValidationPanelProps } from "./ValidationPanel";
