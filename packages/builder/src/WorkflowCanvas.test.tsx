/**
 * Canvas interaction tests.
 *
 * Pointer-driven dragging is not meaningfully simulable in jsdom (no layout, so
 * every bounding box is zero), but selection, linking, delete and the click
 * targets are — and those are where the behaviour lives.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { outputsOf } from "@anthill/workflow";

import {
  FIT_SCALE,
  NO_SELECTION,
  WorkflowCanvas,
  type LinkingState,
  type WorkflowSelection,
} from "./WorkflowCanvas";
import { OUTCOME_STYLES } from "./workflow-canvas-model";

function makeWorkflow(): Workflow {
  return {
    id: "wf",
    name: "Workflow",
    version: "1",
    target: "claude-code",
    metadata: {
      workflow: {
        agents: [
          { id: "r1", name: "Developer" },
          { id: "r2", name: "Reviewer" },
        ],
      },
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 200 } },
      {
        id: "a",
        type: "agent",
        name: "Implement",
        config: {
          actionKind: "agent-step",
          agentId: "r1",
                    task: "x",
          maxIterations: 3,
        },
        position: { x: 200, y: 180 },
      },
      {
        id: "b",
        type: "agent",
        name: "Review",
        config: { actionKind: "llm-review", agentId: "r2", task: "y" },
        position: { x: 500, y: 180 },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b", label: "send to review" },
    ],
  };
}

function renderCanvas(overrides: Partial<React.ComponentProps<typeof WorkflowCanvas>> = {}) {
  // Kept out of the spread so their mock types survive; spreading `overrides`
  // over them widens each to a union and loses `.mock`.
  const onChange = vi.fn<(next: Workflow) => void>();
  const onSelectionChange = vi.fn<(selection: WorkflowSelection) => void>();
  const onLinkingChange = vi.fn<(linking: LinkingState) => void>();

  render(
    <WorkflowCanvas
      workflow={makeWorkflow()}
      selection={NO_SELECTION}
      linking={null}
      {...overrides}
      onChange={onChange}
      onSelectionChange={onSelectionChange}
      onLinkingChange={onLinkingChange}
    />,
  );
  return { onChange, onSelectionChange, onLinkingChange };
}

/** Same as renderCanvas, but able to re-render with new props. */
function renderWithRerender() {
  const base = {
    workflow: makeWorkflow(),
    onChange: vi.fn<(next: Workflow) => void>(),
    selection: NO_SELECTION as WorkflowSelection,
    onSelectionChange: vi.fn<(selection: WorkflowSelection) => void>(),
    linking: null as LinkingState,
    onLinkingChange: vi.fn<(linking: LinkingState) => void>(),
  };
  const view = render(<WorkflowCanvas {...base} />);
  return {
    rerender: (overrides: Partial<React.ComponentProps<typeof WorkflowCanvas>>) =>
      view.rerender(<WorkflowCanvas {...base} {...overrides} />),
  };
}

describe("WorkflowCanvas – rendering", () => {
  it("renders one element per block", () => {
    renderCanvas();
    expect(screen.getByTestId("workflow-block-start")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-block-a")).toHaveTextContent("Implement");
    expect(screen.getByTestId("workflow-block-b")).toHaveTextContent("Review");
  });

  it("shows the action and the assigned agent on a step", () => {
    renderCanvas();
    const block = screen.getByTestId("workflow-block-a");
    expect(block).toHaveTextContent("AGENT STEP");
    expect(block).toHaveTextContent("Developer");
    expect(block).toHaveTextContent("×3");
  });

  it("renders a port for every output", () => {
    renderCanvas();
    expect(screen.getByTestId("port-e1")).toBeInTheDocument();
    expect(screen.getByTestId("port-e2")).toBeInTheDocument();
  });

  it("renders a label only where there is something to say", () => {
    renderCanvas();
    expect(screen.getByTestId("edge-label-e2")).toHaveTextContent("send to review");
    // e1 has neither a label nor a condition.
    expect(screen.queryByTestId("edge-label-e1")).not.toBeInTheDocument();
  });

  it("shows a step's problem count", () => {
    renderCanvas({
      validation: {
        valid: false,
        errors: [{ code: "X", message: "m", nodeId: "a" }],
      },
    });
    expect(screen.getByTestId("workflow-block-a")).toHaveTextContent("1 problem");
  });
});

describe("WorkflowCanvas – selection", () => {
  it("selects a block when it is clicked", () => {
    const props = renderCanvas();
    fireEvent.click(screen.getByTestId("workflow-block-a"));
    expect(props.onSelectionChange).toHaveBeenCalledWith({ kind: "block", nodeId: "a" });
  });

  it("selects an output when its label is clicked", () => {
    const props = renderCanvas();
    fireEvent.click(screen.getByTestId("edge-label-e2"));
    expect(props.onSelectionChange).toHaveBeenCalledWith({
      kind: "output",
      nodeId: "a",
      outputId: "e2",
    });
  });

  it("clears the selection when the empty canvas is clicked", () => {
    const props = renderCanvas({ selection: { kind: "block", nodeId: "a" } });
    fireEvent.click(screen.getByTestId("workflow-canvas"));
    expect(props.onSelectionChange).toHaveBeenCalledWith(NO_SELECTION);
  });
});

describe("WorkflowCanvas – linking", () => {
  it("starts linking when a port is pressed and released without moving", () => {
    const props = renderCanvas();
    fireEvent.pointerDown(screen.getByTestId("port-e2"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(screen.getByTestId("workflow-canvas"), { clientX: 10, clientY: 10 });
    expect(props.onLinkingChange).toHaveBeenCalledWith({ nodeId: "a", outputId: "e2" });
  });

  it("moves the port instead of connecting when the press turns into a drag", () => {
    const props = renderCanvas();
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.pointerDown(screen.getByTestId("port-e2"), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 300 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 300 });

    expect(props.onLinkingChange).not.toHaveBeenCalled();
    const next = props.onChange.mock.calls.at(-1)?.[0];
    const port = next?.edges.find((edge) => edge.id === "e2")?.port;
    expect(Number.isFinite(port?.u)).toBe(true);
    expect(Number.isFinite(port?.v)).toBe(true);
  });

  it("keeps the port where it was for a press that barely moves", () => {
    const props = renderCanvas();
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.pointerDown(screen.getByTestId("port-e2"), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(canvas, { clientX: 12, clientY: 11 });

    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onLinkingChange).toHaveBeenCalledWith({ nodeId: "a", outputId: "e2" });
  });

  it("routes the output to the block that is clicked next", () => {
    const props = renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    fireEvent.click(screen.getByTestId("workflow-block-b"));

    const next = props.onChange.mock.calls[0][0];
    expect(outputsOf(next, "a")[0].target).toBe("b");
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("refuses to point a connection at Start, where a workflow begins", () => {
    const props = renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    fireEvent.click(screen.getByTestId("workflow-block-start"));

    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("refuses to connect a block to itself", () => {
    const props = renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    fireEvent.click(screen.getByTestId("workflow-block-a"));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("cancels linking on Escape", () => {
    const props = renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("cancels linking when the empty canvas is clicked", () => {
    const props = renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    fireEvent.click(screen.getByTestId("workflow-canvas"));
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("shows what is being connected while linking", () => {
    renderCanvas({ linking: { nodeId: "a", outputId: "e2" } });
    const hint = screen.getByTestId("linking-hint");
    expect(hint).toHaveTextContent("send to review");
    expect(hint).toHaveTextContent("Esc");
  });
});

describe("WorkflowCanvas – deleting an arrow", () => {
  it("detaches the arrow but keeps the output and its port", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    fireEvent.keyDown(window, { key: "Delete" });

    const next = props.onChange.mock.calls[0][0];
    const outputs = outputsOf(next, "a");
    // Removing the output outright would lose its label, kind and condition,
    // and leave nothing to re-route.
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      id: "e2",
      label: "send to review",
      target: null,
    });
  });

  it("keeps the output selected so it can be pointed somewhere else", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(props.onSelectionChange).not.toHaveBeenCalled();
  });

  it("removes the output on a second press, once it is already detached", () => {
    const workflow = makeWorkflow();
    workflow.edges = workflow.edges.filter((edge) => edge.id !== "e2");
    workflow.nodes[1].config.pendingOutputs = [{ id: "e2", kind: "next" }];

    const props = renderCanvas({
      workflow,
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    fireEvent.keyDown(window, { key: "Delete" });

    const next = props.onChange.mock.calls.at(-1)?.[0];
    expect(next?.nodes.find((node) => node.id === "a")?.config.pendingOutputs)
      .toBeUndefined();
    expect(props.onSelectionChange).toHaveBeenCalledWith(NO_SELECTION);
  });

  it("does nothing for an output that is not there", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "gone" },
    });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("leaves Backspace alone while the user is typing", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(window, { key: "Backspace" });
    expect(props.onChange).not.toHaveBeenCalled();

    input.remove();
  });
});

describe("WorkflowCanvas – re-routing by dragging the arrowhead", () => {
  it("shows a grab handle only on the selected arrow", () => {
    const { rerender } = renderWithRerender();
    expect(screen.queryByTestId("arrow-handle-e2")).not.toBeInTheDocument();

    rerender({ selection: { kind: "output", nodeId: "a", outputId: "e2" } });
    expect(screen.getByTestId("arrow-handle-e2")).toBeInTheDocument();
  });

  it("picking the handle up starts pointing that output somewhere else", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    expect(props.onLinkingChange).toHaveBeenCalledWith({ nodeId: "a", outputId: "e2" });
  });
});

describe("WorkflowCanvas – bending a line", () => {
  const selected = { kind: "output" as const, nodeId: "a", outputId: "e2" };

  it("shows a bend handle only on the selected line", () => {
    const { rerender } = renderWithRerender();
    expect(screen.queryByTestId("bend-handle-e2")).not.toBeInTheDocument();

    rerender({ selection: selected });
    expect(screen.getByTestId("bend-handle-e2")).toBeInTheDocument();
  });

  it("dragging the handle bends the line", () => {
    const props = renderCanvas({ selection: selected });
    fireEvent.pointerDown(screen.getByTestId("bend-handle-e2"));
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), {
      clientX: 400,
      clientY: 40,
    });

    const next = props.onChange.mock.calls.at(-1)?.[0];
    const bend = next?.edges.find((edge) => edge.id === "e2")?.bend;
    expect(Number.isFinite(bend?.along)).toBe(true);
    expect(bend?.across).not.toBe(0);
  });

  it("keeps the line selected after bending it", () => {
    const props = renderCanvas({ selection: selected });
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.pointerDown(screen.getByTestId("bend-handle-e2"));
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 40 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 40 });
    // The click that ends a drag lands on the surface, which would otherwise
    // read as clicking the background.
    fireEvent.click(canvas);

    expect(props.onSelectionChange).not.toHaveBeenCalledWith(NO_SELECTION);
  });

  it("double-clicking the handle straightens the line again", () => {
    const workflow = makeWorkflow();
    workflow.edges[1].bend = { along: 0.2, across: -0.4 };
    const props = renderCanvas({ workflow, selection: selected });

    fireEvent.doubleClick(screen.getByTestId("bend-handle-e2"));
    const next = props.onChange.mock.calls.at(-1)?.[0];
    expect(next?.edges.find((edge) => edge.id === "e2")?.bend).toBeUndefined();
  });
});

describe("WorkflowCanvas – deleting a block", () => {
  it("removes the block", () => {
    const props = renderCanvas({ selection: { kind: "block", nodeId: "a" } });
    fireEvent.keyDown(window, { key: "Backspace" });

    const next = props.onChange.mock.calls.at(-1)?.[0];
    expect(next?.nodes.some((node) => node.id === "a")).toBe(false);
  });

  it("takes its connections with it, rather than leaving them dangling", () => {
    const props = renderCanvas({ selection: { kind: "block", nodeId: "a" } });
    fireEvent.keyDown(window, { key: "Delete" });

    const next = props.onChange.mock.calls.at(-1)?.[0];
    expect(next?.edges.some((edge) => edge.source === "a" || edge.target === "a")).toBe(
      false,
    );
  });

  it("clears the selection, since what was selected is gone", () => {
    const props = renderCanvas({ selection: { kind: "block", nodeId: "a" } });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(props.onSelectionChange).toHaveBeenCalledWith(NO_SELECTION);
  });

  it("does nothing for a block that is not there", () => {
    const props = renderCanvas({ selection: { kind: "block", nodeId: "gone" } });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe("WorkflowCanvas – reconnecting with a generous target", () => {
  /** Where a point of the workflow is on screen: the graph is drawn at FIT_SCALE (ANT-165). */
  const onScreen = (x: number, y: number) => ({ clientX: x * FIT_SCALE, clientY: y * FIT_SCALE });

  const dragArrowheadTo = (x: number, y: number, overrides = {}) => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      ...overrides,
    });
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    fireEvent.pointerMove(canvas, onScreen(x, y));
    fireEvent.pointerUp(canvas, onScreen(x, y));
    return props;
  };

  it("connects to a block the arrow was released just outside of", () => {
    // "b" spans x 500..696, y 180..280. Released 24px past its right edge.
    const props = dragArrowheadTo(720, 230, {
      linking: { nodeId: "a", outputId: "e2" },
    });
    const next = props.onChange.mock.calls.at(-1)?.[0];
    expect(outputsOf(next as Workflow, "a")[0].target).toBe("b");
  });

  it("keeps the released point as the landing, projected onto the near side", () => {
    const props = dragArrowheadTo(720, 230, {
      linking: { nodeId: "a", outputId: "e2" },
    });
    const next = props.onChange.mock.calls.at(-1)?.[0];
    const anchor = outputsOf(next as Workflow, "a")[0].anchor;
    // Past the right edge and level with the middle: u beyond 1, clamped when
    // drawn, so the arrowhead sits on the right-hand side.
    expect(anchor?.u).toBeGreaterThan(0.9);
    expect(anchor?.v).toBeCloseTo(0.5, 1);
  });

  it("leaves the arrow alone when released in open space", () => {
    const props = dragArrowheadTo(4000, 4000, {
      linking: { nodeId: "a", outputId: "e2" },
    });
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onLinkingChange).toHaveBeenCalledWith(null);
  });

  it("marks the block under the arrowhead before it is released", () => {
    renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      linking: { nodeId: "a", outputId: "e2" },
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), onScreen(560, 230));

    expect(screen.getByTestId("workflow-block-b")).toHaveAttribute("data-snap-target", "true");
    expect(screen.getByTestId("workflow-block-start")).not.toHaveAttribute("data-snap-target");
  });

  it("never marks an illegal target, however close the pointer is", () => {
    renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      linking: { nodeId: "a", outputId: "e2" },
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    // Straight over Start, which nothing may point at.
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), onScreen(40, 210));
    expect(screen.getByTestId("workflow-block-start")).not.toHaveAttribute("data-snap-target");
  });

  it("never marks the block the arrow leaves from", () => {
    renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      linking: { nodeId: "a", outputId: "e2" },
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), onScreen(260, 230));
    expect(screen.getByTestId("workflow-block-a")).not.toHaveAttribute("data-snap-target");
  });
});

describe("WorkflowCanvas – the arrow itself moves", () => {
  const startDrag = (overrides = {}) => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      linking: { nodeId: "a", outputId: "e2" },
      ...overrides,
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    return props;
  };

  it("draws no live arrow before the drag starts", () => {
    renderCanvas({ selection: { kind: "output", nodeId: "a", outputId: "e2" } });
    expect(screen.queryByTestId("live-edge")).not.toBeInTheDocument();
  });

  it("draws the arrow at the pointer once it is being dragged", () => {
    startDrag();
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), { clientX: 600, clientY: 400 });
    expect(screen.getByTestId("live-edge")).toBeInTheDocument();
  });

  it("reshapes it as the pointer moves", () => {
    startDrag();
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.pointerMove(canvas, { clientX: 600, clientY: 400 });
    const first = screen.getByTestId("live-edge").getAttribute("d");
    fireEvent.pointerMove(canvas, { clientX: 900, clientY: 700 });
    expect(screen.getByTestId("live-edge").getAttribute("d")).not.toBe(first);
  });

  it("shows one arrow, not two – the real one stands aside", () => {
    startDrag();
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), { clientX: 600, clientY: 400 });
    // The static path for this output is suppressed while the live one stands
    // in for it, so there is never a moment with a phantom beside the real one.
    const paths = document.querySelectorAll("path[marker-end]");
    const forE2 = [...paths].filter((path) => path.getAttribute("d")?.includes("M "));
    expect(forE2.length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("live-edge")).toHaveLength(1);
  });

  it("keeps the connection's own colour and arrowhead, not a phantom's", () => {
    startDrag();
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), { clientX: 600, clientY: 400 });
    const live = screen.getByTestId("live-edge");
    expect(live).toHaveAttribute("stroke", OUTCOME_STYLES.next.color);
    expect(live).toHaveAttribute("marker-end", "url(#arrow-next)");
  });

  it("changes nothing in the document while the drag is in flight", () => {
    const props = startDrag();
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), { clientX: 600, clientY: 400 });
    // Which is what makes cancelling free: there is no edit to undo.
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("puts the arrow back exactly as it was when the drag is cancelled", () => {
    const { rerender } = renderWithRerender();
    rerender({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
      linking: { nodeId: "a", outputId: "e2" },
    });
    fireEvent.pointerDown(screen.getByTestId("arrow-handle-e2"));
    fireEvent.pointerMove(screen.getByTestId("workflow-canvas"), { clientX: 600, clientY: 400 });
    expect(screen.getByTestId("live-edge")).toBeInTheDocument();

    rerender({ selection: { kind: "output", nodeId: "a", outputId: "e2" }, linking: null });
    expect(screen.queryByTestId("live-edge")).not.toBeInTheDocument();
  });
});

describe("WorkflowCanvas – zoom shortcuts", () => {
  const zoomLabel = () => screen.getByTestId("zoom-level").textContent;

  it("zooms in on ⌘+", () => {
    renderCanvas();
    const before = zoomLabel();
    fireEvent.keyDown(window, { key: "+", metaKey: true });
    expect(zoomLabel()).not.toBe(before);
  });

  it("accepts the unshifted key that carries the plus sign", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(zoomLabel()).toBe(`${Math.round(FIT_SCALE * 115)}%`);
  });

  it("zooms out on ⌘−", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(zoomLabel()).toBe(`${Math.round((FIT_SCALE / 1.15) * 100)}%`);
  });

  it("stops the application zooming instead", () => {
    renderCanvas();
    const event = new KeyboardEvent("keydown", {
      key: "+",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps out of the way while the author is typing", () => {
    renderCanvas();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    const before = zoomLabel();
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    // "+" and "-" are ordinary characters in a task description.
    expect(zoomLabel()).toBe(before);
    field.remove();
  });

  it("ignores the keys without the modifier", () => {
    renderCanvas();
    const before = zoomLabel();
    fireEvent.keyDown(window, { key: "+" });
    expect(zoomLabel()).toBe(before);
  });

  it("stays inside the limits the buttons use", () => {
    renderCanvas();
    for (let press = 0; press < 30; press += 1) {
      fireEvent.keyDown(window, { key: "+", metaKey: true });
    }
    expect(zoomLabel()).toBe("200%");
  });
});

describe("WorkflowCanvas – navigation controls", () => {
  it("says what the fit button does in words", () => {
    renderCanvas();
    expect(screen.getByText("Show whole workflow")).toBeInTheDocument();
  });

  it("names the centring control after what it centres", () => {
    renderCanvas();
    expect(screen.getByText("Center connection on block")).toBeInTheDocument();
  });

  it("offers it only when there is something to centre", () => {
    renderCanvas();
    expect(screen.getByTestId("center-outputs")).toBeDisabled();
    expect(screen.getByTestId("center-outputs")).toHaveAttribute(
      "title",
      "Select an arrow or a block first",
    );
  });

  it("acts on the selected connection", () => {
    const props = renderCanvas({
      selection: { kind: "output", nodeId: "a", outputId: "e2" },
    });
    const button = screen.getByTestId("center-outputs");
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute(
      "title",
      "Move this connection's ends to the middle of the sides they meet",
    );
  });
});

/**
 * The one time the graph builds instead of appearing.
 *
 * The reveal is CSS: each element carries its moment as a variable, the
 * stylesheet owns the motion, and reduced-motion switches the whole thing off
 * in one rule. What the component owes the plan is exactly two things — the
 * class, and a delay that respects the plan's order.
 */
describe("assembling an accepted draft", () => {
  const delayOf = (el: Element) =>
    Number.parseFloat(
      ((el as HTMLElement).style.getPropertyValue("--assembly-delay") || "0").replace("s", ""),
    );

  it("marks every block and connection for the reveal, delays in plan order", () => {
    renderCanvas({ assembling: true });

    const start = screen.getByTestId("workflow-block-start");
    const a = screen.getByTestId("workflow-block-a");
    const b = screen.getByTestId("workflow-block-b");
    for (const el of [start, a, b]) expect(el.className).toContain("canvas-assemble");

    // Blocks walk the flow: start, then a, then b.
    expect(delayOf(start)).toBeLessThan(delayOf(a));
    expect(delayOf(a)).toBeLessThan(delayOf(b));

    // Connections come after every block they touch.
    const edges = [...document.querySelectorAll("g.canvas-assemble")];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(delayOf(edge)).toBeGreaterThan(delayOf(b));
    }
  });

  it("draws an opened workflow at once, with nothing marked", () => {
    renderCanvas();
    expect(document.querySelector(".canvas-assemble")).toBeNull();
  });

  it("does not move anything: the geometry is the same with and without the reveal", () => {
    renderCanvas({ assembling: true });
    const during = screen.getByTestId("workflow-block-a");
    const at = { left: during.style.left, top: during.style.top };
    cleanup();

    renderCanvas();
    const after = screen.getByTestId("workflow-block-a");
    expect({ left: after.style.left, top: after.style.top }).toEqual(at);
  });
});

/**
 * A workflow handed over by a harness arrives without positions, so the canvas
 * has to invent them. They are a view and never a revision — nothing here is
 * written back — but they are what the author is looking at, and a block that
 * moved because a different block was added would be the canvas rearranging
 * their drawing underneath them.
 */
describe("a workflow handed over without positions", () => {
  function handover(): Workflow {
    return {
      id: "handover",
      name: "Handover",
      version: "1",
      target: "claude-code",
      metadata: { workflow: { agents: [{ id: "r1", name: "Developer" }] } },
      nodes: [
        { id: "start", type: "start", name: "Start", config: {} },
        {
          id: "a",
          type: "agent",
          name: "Implement",
          config: { actionKind: "agent-step", agentId: "r1", task: "x" },
        },
        {
          id: "b",
          type: "agent",
          name: "Review",
          config: { actionKind: "llm-review", agentId: "r1", task: "y" },
        },
        { id: "end", type: "end", name: "End", config: {} },
      ],
      edges: [
        { id: "e1", source: "start", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "end" },
      ],
    };
  }

  const boxes = () =>
    ["start", "a", "b", "end"].map((id) => {
      const block = screen.getByTestId(`workflow-block-${id}`);
      return { id, left: block.style.left, top: block.style.top };
    });

  /**
   * A handover carries no positions, so nothing on screen is the author's
   * arrangement and the drawing follows the graph (ANT-117).
   *
   * Keeping the blocks where they were put the added one past the end block,
   * and the edge into `end` then ran right to left underneath it.
   */
  it("lays the drawing out again when a block is added to an untouched handover", () => {
    const props = {
      onChange: vi.fn<(next: Workflow) => void>(),
      selection: NO_SELECTION as WorkflowSelection,
      onSelectionChange: vi.fn<(selection: WorkflowSelection) => void>(),
      linking: null as LinkingState,
      onLinkingChange: vi.fn<(linking: LinkingState) => void>(),
    };
    const view = render(<WorkflowCanvas {...props} workflow={handover()} />);

    const grown = handover();
    grown.nodes.push({ id: "c", type: "agent", name: "Check", config: {} });
    grown.edges.push({ id: "e4", source: "b", target: "c" });
    grown.edges = grown.edges.filter((edge) => !(edge.source === "b" && edge.target === "end"));
    grown.edges.push({ id: "e5", source: "c", target: "end" });
    view.rerender(<WorkflowCanvas {...props} workflow={grown} />);

    expect(screen.getByTestId("workflow-block-c")).toBeInTheDocument();
    const left = (id: string) =>
      parseFloat(screen.getByTestId(`workflow-block-${id}`).style.left);
    // `end` is last in the graph, so it is last on the canvas — and the edge
    // into it therefore runs forwards rather than back under it.
    expect(left("end")).toBeGreaterThan(left("c"));
    expect(left("c")).toBeGreaterThan(left("b"));
  });
});
