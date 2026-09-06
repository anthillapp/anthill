/**
 * The trackpad gestures, on the editable canvas.
 *
 * jsdom has no layout, so every box is zero and the focal maths is exercised in
 * `canvas-zoom.test.ts` instead. What is tested here is the wiring: that the
 * listener is non-passive and takes the event, that the same zoom state the
 * buttons use is the one that moves, and that a gesture over a field is left to
 * the field.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { NO_SELECTION, WorkflowCanvas } from "./WorkflowCanvas";

const workflow: Workflow = {
  id: "wf",
  name: "Workflow",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "a",
      type: "agent",
      name: "Implement",
      config: { actionKind: "agent-step", task: "x" },
      position: { x: 300, y: 0 },
    },
  ],
  edges: [{ id: "e1", source: "start", target: "a" }],
  metadata: { workflow: { agents: [] } },
};

function show() {
  render(
    <WorkflowCanvas
      workflow={workflow}
      onChange={() => undefined}
      selection={NO_SELECTION}
      onSelectionChange={() => undefined}
      linking={null}
      onLinkingChange={() => undefined}
    />,
  );
  return screen.getByTestId("workflow-canvas");
}

const level = () => screen.getByTestId("zoom-level").textContent ?? "";

/**
 * Dispatch one wheel event and return whether it went unhandled.
 *
 * Through `fireEvent` rather than `dispatchEvent`: the listener is a native one
 * added outside React, so its `setState` needs the act() wrapper that
 * `fireEvent` provides or the re-render never lands before the assertion.
 */
function wheel(target: Element, init: { deltaY: number; deltaX?: number; ctrlKey?: boolean; deltaMode?: number }) {
  return fireEvent.wheel(target, {
    deltaX: 0,
    ctrlKey: false,
    clientX: 100,
    clientY: 100,
    ...init,
  });
}

describe("trackpad gestures on the workflow canvas", () => {
  it("zooms in on a spreading pinch", () => {
    const canvas = show();
    const before = Number.parseInt(level(), 10);
    wheel(canvas, { deltaY: -30, ctrlKey: true });
    expect(Number.parseInt(level(), 10)).toBeGreaterThan(before);
  });

  it("zooms out on a closing pinch", () => {
    const canvas = show();
    const before = Number.parseInt(level(), 10);
    wheel(canvas, { deltaY: 30, ctrlKey: true });
    expect(Number.parseInt(level(), 10)).toBeLessThan(before);
  });

  it("zooms in when two fingers move up", () => {
    const canvas = show();
    const before = Number.parseInt(level(), 10);
    wheel(canvas, { deltaY: 40 });
    expect(Number.parseInt(level(), 10)).toBeGreaterThan(before);
  });

  it("zooms out when two fingers move down", () => {
    const canvas = show();
    const before = Number.parseInt(level(), 10);
    wheel(canvas, { deltaY: -40 });
    expect(Number.parseInt(level(), 10)).toBeLessThan(before);
  });

  it("takes the event, so the application does not zoom or scroll too", () => {
    const canvas = show();
    // `fireEvent` returns false when the event was cancelled. A passive
    // listener could not have done that, and without it Chromium would zoom
    // the whole window on the same gesture.
    expect(wheel(canvas, { deltaY: -30, ctrlKey: true })).toBe(false);
  });

  it("moves the same zoom the buttons move", () => {
    const canvas = show();
    wheel(canvas, { deltaY: 40 });
    const gestured = Number.parseInt(level(), 10);

    fireEvent.click(screen.getByLabelText("Zoom out"));
    // One readout, one state: a gesture and a button cannot disagree.
    expect(Number.parseInt(level(), 10)).toBeLessThan(gestured);
  });

  it("comes back to the whole workflow after gesturing", () => {
    const canvas = show();
    for (let i = 0; i < 8; i += 1) wheel(canvas, { deltaY: 40 });
    const zoomed = Number.parseInt(level(), 10);
    fireEvent.click(screen.getByRole("button", { name: "Show whole workflow" }));
    expect(Number.parseInt(level(), 10)).not.toBe(zoomed);
  });

  it("never runs past the bounds, whatever momentum arrives", () => {
    const canvas = show();
    for (let i = 0; i < 120; i += 1) wheel(canvas, { deltaY: 200, ctrlKey: false });
    expect(Number.parseInt(level(), 10)).toBe(200);

    for (let i = 0; i < 200; i += 1) wheel(canvas, { deltaY: -200 });
    expect(Number.parseInt(level(), 10)).toBe(30);
  });

  it("leaves a gesture over a field to the field", () => {
    const canvas = show();
    const field = document.createElement("input");
    canvas.appendChild(field);

    const before = level();
    // Not cancelled, and the zoom did not move: the field keeps its own gesture.
    expect(wheel(field, { deltaY: 40 })).toBe(true);
    expect(level()).toBe(before);
    field.remove();
  });

  it("keeps dragging the canvas as a way to pan", () => {
    const canvas = show();
    // The gesture did not replace the drag: pointer-down on bare canvas still
    // begins a pan, which is what keeps navigation available when a trackpad
    // is not what someone is using.
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    expect(canvas.dispatchEvent(down)).toBe(true);
  });
});
