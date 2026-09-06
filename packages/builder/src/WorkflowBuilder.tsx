/**
 * WorkflowBuilder: the top-level authoring surface.
 *
 * Composes NodePalette + Canvas + NodePropertyPanel + ValidationPanel over a
 * single `Workflow` value. Works either controlled (pass `workflow`) or
 * uncontrolled (pass `initialWorkflow`; state lives in this component). No
 * global state library — the whole document is one immutable value.
 *
 * This component edits workflow DEFINITIONS only. Running a workflow belongs to
 * `@anthill/engine` and is intentionally absent here.
 */

import { useCallback, useMemo, useState } from "react";

import { Canvas, type CanvasSelection } from "./Canvas";
import { NodePalette } from "./NodePalette";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { ValidationPanel } from "./ValidationPanel";
import type { Workflow } from "./contracts";
import { createEmptyWorkflow } from "./document";
import { validate } from "./validate";

export type WorkflowBuilderProps = {
  /** Controlled mode: the workflow to render. */
  workflow?: Workflow;
  /** Uncontrolled mode: the starting workflow (ignored if `workflow` is set). */
  initialWorkflow?: Workflow;
  /** Called with the next workflow after every edit, in both modes. */
  onChange?: (next: Workflow) => void;
  className?: string;
};

const EMPTY_SELECTION: CanvasSelection = { nodeId: null, edgeId: null };

export function WorkflowBuilder({
  workflow: controlled,
  initialWorkflow,
  onChange,
  className,
}: WorkflowBuilderProps) {
  const [internal, setInternal] = useState<Workflow>(
    () => initialWorkflow ?? createEmptyWorkflow(),
  );
  const [selection, setSelection] = useState<CanvasSelection>(EMPTY_SELECTION);

  const workflow = controlled ?? internal;

  const handleChange = useCallback(
    (next: Workflow) => {
      if (controlled === undefined) setInternal(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );

  const validation = useMemo(() => validate(workflow), [workflow]);

  const selectNode = useCallback(
    (nodeId: string) => setSelection({ nodeId, edgeId: null }),
    [],
  );

  return (
    <div
      data-testid="workflow-builder"
      className={className}
      style={{ display: "flex", gap: 12, height: "100%", minHeight: 400 }}
    >
      <NodePalette workflow={workflow} onChange={handleChange} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Canvas
          workflow={workflow}
          onChange={handleChange}
          validation={validation}
          selectedNodeId={selection.nodeId}
          selectedEdgeId={selection.edgeId}
          onSelectionChange={setSelection}
        />
      </div>
      <div style={{ width: 320, overflow: "auto" }}>
        <NodePropertyPanel
          workflow={workflow}
          selectedNodeId={selection.nodeId}
          onChange={handleChange}
        />
        <ValidationPanel
          workflow={workflow}
          result={validation}
          onSelectNode={selectNode}
        />
      </div>
    </div>
  );
}

export default WorkflowBuilder;
