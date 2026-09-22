/**
 * `@anthill/builder/react-flow` — the legacy React Flow (`@xyflow/react`)
 * surface: `Canvas` and the `WorkflowBuilder` that composes it.
 *
 * The main entry (`@anthill/builder`) does not import `@xyflow/react`;
 * importing this subpath is what pulls it in. The hand-written canvas
 * (`WorkflowCanvas`) lives in the main entry and does not need it.
 *
 * Consumers must import React Flow's stylesheet once in their app entry:
 *   import "@xyflow/react/dist/style.css";
 */

export { Canvas, type CanvasProps, type CanvasSelection } from "./Canvas";
export { WorkflowBuilder, type WorkflowBuilderProps } from "./WorkflowBuilder";
