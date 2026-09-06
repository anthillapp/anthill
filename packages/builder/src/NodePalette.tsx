/**
 * NodePalette: the six MVP node types. Clicking one adds a node of that type
 * to the workflow at a default (staggered) position.
 */

import type { NodeType, Workflow } from "./contracts";
import { NODE_TYPES } from "./contracts";
import { NODE_TYPE_LABELS, addNode, createNode } from "./document";
import { Button, Panel } from "./ui-local";

export type NodePaletteProps = {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  /** Where the first added node lands; later ones are staggered from here. */
  origin?: { x: number; y: number };
  className?: string;
};

const STAGGER = 60;

export function defaultPositionFor(
  workflow: Workflow,
  origin = { x: 80, y: 80 },
): { x: number; y: number } {
  const index = workflow.nodes.length;
  return { x: origin.x + index * STAGGER, y: origin.y + index * STAGGER };
}

export function NodePalette({
  workflow,
  onChange,
  origin,
  className,
}: NodePaletteProps) {
  const handleAdd = (type: NodeType) => {
    const node = createNode(workflow, type, {
      position: defaultPositionFor(workflow, origin),
    });
    onChange(addNode(workflow, node));
  };

  return (
    <Panel title="Node palette" className={className}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {NODE_TYPES.map((type) => (
          <li key={type}>
            <Button
              onClick={() => handleAdd(type)}
              title={`Add ${NODE_TYPE_LABELS[type]} node`}
            >
              {NODE_TYPE_LABELS[type]}
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default NodePalette;
