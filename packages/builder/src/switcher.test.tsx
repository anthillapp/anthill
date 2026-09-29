/**
 * The switcher (ANT-165): two or more connected `switch` exits drawn as one
 * stem, one hub and a thin finger per exit.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowEdge } from "@anthill/workflow-schema";

import { PORT_OFFSET } from "./geometry";
import { NO_SELECTION, WorkflowCanvas, type WorkflowSelection } from "./WorkflowCanvas";
import {
  OUTCOME_STYLES,
  SWITCH_HUB_RADIUS,
  SWITCH_STEM,
  SWITCH_WARN,
  buildCanvasModel,
  switchStemPath,
} from "./workflow-canvas-model";

afterEach(cleanup);

/** The workflow the design was modelled on: a gate that chooses one of two notes. */
function gatePaths(edges: WorkflowEdge[] = choiceEdges()): Workflow {
  return {
    id: "wf",
    name: "Gate paths",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 210 } },
      { id: "gate", type: "approval", name: "Approve the codename", config: {}, position: { x: 200, y: 180 } },
      // In line with the gate.
      { id: "with", type: "agent", name: "Note with codename", config: { actionKind: "agent-step" }, position: { x: 520, y: 180 } },
      // A row below.
      { id: "without", type: "agent", name: "Note without codename", config: { actionKind: "agent-step" }, position: { x: 520, y: 400 } },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 840, y: 210 } },
    ],
    edges: [
      { id: "e0", source: "start", target: "gate" },
      ...edges,
      { id: "e3", source: "with", target: "end" },
      { id: "e4", source: "without", target: "end" },
    ],
  };
}

function choiceEdges(): WorkflowEdge[] {
  return [
    { id: "approved", source: "gate", target: "with", kind: "switch", label: "approved", condition: "you approve the codename" },
    { id: "declined", source: "gate", target: "without", kind: "switch", label: "declined" },
  ];
}

describe("buildCanvasModel – switcher", () => {
  it("draws two switch exits as one switcher leaving the right-edge centre", () => {
    const model = buildCanvasModel(gatePaths());
    expect(model.switchers).toHaveLength(1);
    const [shape] = model.switchers;
    // The gate is 196×100 at (200, 180).
    expect(shape.port).toMatchObject({ x: 200 + 196 + PORT_OFFSET, y: 230 });
    expect(shape.hub).toEqual({ x: shape.port.x + SWITCH_STEM, y: 230 });
    expect(shape.outputIds).toEqual(["approved", "declined"]);
    expect(shape.problem).toBeUndefined();
  });

  it("starts every finger at the hub's centre, thin and solid", () => {
    const model = buildCanvasModel(gatePaths());
    const fingers = model.connected.filter((path) => path.switcher === "gate");
    expect(fingers.map((path) => path.output.id)).toEqual(["approved", "declined"]);
    for (const finger of fingers) {
      expect(finger.geometry.from).toMatchObject(model.switchers[0].hub);
      expect(finger.style).toEqual(OUTCOME_STYLES.switch);
      expect(finger.style.dash).toBeUndefined();
    }
  });

  it("draws the finger to the block in line as a straight line", () => {
    const model = buildCanvasModel(gatePaths());
    const inLine = model.connected.find((path) => path.output.id === "approved")!;
    expect(inLine.geometry.path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    const below = model.connected.find((path) => path.output.id === "declined")!;
    expect(below.geometry.path).not.toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  });

  it("stops the stem at the hub's rim", () => {
    const [shape] = buildCanvasModel(gatePaths()).switchers;
    expect(switchStemPath(shape)).toBe(
      `M ${shape.port.x} ${shape.port.y} L ${shape.hub.x - SWITCH_HUB_RADIUS} ${shape.hub.y}`,
    );
  });

  it("leaves one switch exit a plain arrow", () => {
    const [approved] = choiceEdges();
    const model = buildCanvasModel(gatePaths([approved, { id: "other", source: "gate", target: "without" }]));
    expect(model.switchers).toEqual([]);
    expect(model.connected.every((path) => path.switcher === undefined)).toBe(true);
  });

  it("never forms a switcher out of rework", () => {
    const model = buildCanvasModel(
      gatePaths(choiceEdges().map((edge) => ({ ...edge, kind: "rework" as const }))),
    );
    expect(model.switchers).toEqual([]);
  });

  it("keeps other exits of the same block off the stem", () => {
    const model = buildCanvasModel(
      gatePaths([...choiceEdges(), { id: "ask", source: "gate", target: "end", kind: "question" }]),
    );
    const [shape] = model.switchers;
    const ask = model.connected.find((path) => path.output.id === "ask")!;
    expect(ask.switcher).toBeUndefined();
    expect(ask.port.y).not.toBe(shape.port.y);
  });

  it("flags two exits with no condition", () => {
    const [approved, declined] = choiceEdges();
    const model = buildCanvasModel(gatePaths([{ ...approved, condition: undefined }, declined]));
    expect(model.switchers[0].problem).toBe(
      "Two exits have no condition — only one can be the otherwise path.",
    );
  });

  it("flags an otherwise exit that is not the last", () => {
    const [approved, declined] = choiceEdges();
    const model = buildCanvasModel(
      gatePaths([{ ...declined }, { ...approved }]),
    );
    expect(model.switchers[0].problem).toBe("The otherwise exit must be the last one.");
  });
});

describe("WorkflowCanvas – switcher", () => {
  function renderGate(workflow = gatePaths()) {
    const onSelectionChange = vi.fn<(selection: WorkflowSelection) => void>();
    render(
      <WorkflowCanvas
        workflow={workflow}
        selection={NO_SELECTION}
        linking={null}
        onChange={vi.fn()}
        onSelectionChange={onSelectionChange}
        onLinkingChange={vi.fn()}
      />,
    );
    return { onSelectionChange };
  }

  it("draws one port dot for the switcher and none for its fingers", () => {
    renderGate();
    expect(screen.getByTestId("switch-port-gate")).toBeTruthy();
    expect(screen.queryByTestId("port-approved")).toBeNull();
    expect(screen.queryByTestId("port-declined")).toBeNull();
  });

  it("draws the hub after the fingers, so it covers where they start", () => {
    renderGate();
    const switcher = screen.getByTestId("switcher-gate");
    const finger = document.querySelector('path[marker-end="url(#arrow-switch)"]')!;
    expect(finger).toBeTruthy();
    expect(finger.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(switcher.querySelector("circle")).toBeTruthy();
  });

  it("labels a finger with the exit's name only", () => {
    renderGate();
    const label = screen.getByTestId("edge-label-approved");
    expect(label.textContent).toBe("approved");
  });

  it("turns amber when exactly one path is not decided", () => {
    const [approved, declined] = choiceEdges();
    renderGate(gatePaths([declined, approved]));
    const switcher = screen.getByTestId("switcher-gate");
    expect(switcher.getAttribute("data-problem")).toBe("true");
    expect(switcher.querySelector("circle")!.getAttribute("fill")).toBe(SWITCH_WARN.fill);
  });

  it("selects the block from the switcher's port dot", () => {
    const { onSelectionChange } = renderGate();
    fireEvent.click(screen.getByTestId("switch-port-gate"));
    expect(onSelectionChange).toHaveBeenCalledWith({ kind: "block", nodeId: "gate" });
  });
});
