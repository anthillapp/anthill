/**
 * Canvas tests are deliberately shallow: pointer-driven node dragging and
 * handle-to-handle edge drawing are @xyflow/react internals that cannot be
 * simulated meaningfully in jsdom (no layout, no real pointer capture). The
 * document-level consequences of those gestures are covered by document.test.ts.
 * What we check here is that the canvas renders the given graph and wires up its
 * change handlers.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Canvas } from "./Canvas";
import type { Workflow } from "./contracts";
import { createEmptyWorkflow } from "./document";
import { validate } from "./validate";

function workflowWithGraph(): Workflow {
  return {
    ...createEmptyWorkflow(),
    nodes: [
      {
        id: "start-1",
        type: "start",
        name: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "agent-1",
        type: "agent",
        name: "Developer",
        config: { role: "dev", runtime: "claude-code", instructions: "go" },
        position: { x: 200, y: 0 },
      },
    ],
    edges: [
      { id: "edge-1", source: "start-1", target: "agent-1", label: "begin" },
    ],
  };
}

describe("Canvas", () => {
  it("renders an empty workflow without crashing", () => {
    render(<Canvas workflow={createEmptyWorkflow()} onChange={vi.fn()} />);
    expect(screen.getByTestId("workflow-canvas")).toBeInTheDocument();
  });

  it("renders one box per node, labelled with the node name", () => {
    render(<Canvas workflow={workflowWithGraph()} onChange={vi.fn()} />);

    expect(screen.getByTestId("canvas-node-start")).toBeInTheDocument();
    const agent = screen.getByTestId("canvas-node-agent");
    expect(agent).toHaveTextContent("Developer");
    expect(agent).toHaveTextContent("Agent");
  });

  it("mounts the edge layer for a workflow that has edges", () => {
    // jsdom has no layout, so React Flow never measures the nodes and does not
    // paint the SVG edge paths. All we can assert here is that a workflow with
    // edges mounts cleanly and the edge layer exists; edge semantics live in
    // document.test.ts.
    const { container } = render(
      <Canvas workflow={workflowWithGraph()} onChange={vi.fn()} />,
    );
    expect(container.querySelector(".react-flow__edges")).toBeTruthy();
    expect(screen.getAllByTestId(/^canvas-node-/)).toHaveLength(2);
  });

  it("badges nodes that have validation errors", () => {
    const workflow = workflowWithGraph();
    workflow.nodes[1] = { ...workflow.nodes[1]!, config: {} };

    render(
      <Canvas
        workflow={workflow}
        onChange={vi.fn()}
        validation={validate(workflow)}
      />,
    );

    // role + runtime + instructions
    expect(screen.getByTestId("canvas-node-agent")).toHaveTextContent(
      "3 issues",
    );
  });

  it("reports the clicked node as the new selection", () => {
    const onSelectionChange = vi.fn();
    render(
      <Canvas
        workflow={workflowWithGraph()}
        onChange={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByTestId("canvas-node-agent"));

    expect(onSelectionChange).toHaveBeenCalledWith({
      nodeId: "agent-1",
      edgeId: null,
    });
  });

  it("does not call onChange while merely rendering", () => {
    const onChange = vi.fn();
    render(<Canvas workflow={workflowWithGraph()} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
