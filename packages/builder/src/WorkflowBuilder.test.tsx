import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowBuilder } from "./react-flow";
import type { Workflow } from "./contracts";
import { createEmptyWorkflow } from "./document";
import { ValidationCode } from "./validate";

function palette() {
  return within(screen.getByRole("region", { name: "Node palette" }));
}

function addFromPalette(label: string) {
  fireEvent.click(palette().getByRole("button", { name: label }));
}

describe("WorkflowBuilder", () => {
  it("renders palette, canvas, property panel and validation panel", () => {
    render(<WorkflowBuilder />);

    expect(screen.getByRole("region", { name: "Node palette" })).toBeVisible();
    expect(screen.getByTestId("workflow-canvas")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Node properties" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Validation" })).toBeVisible();
  });

  it("offers all six node types in the palette", () => {
    render(<WorkflowBuilder />);
    expect(palette().getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Start",
      "Agent",
      "Approval",
      "Condition",
      "Command",
      "End",
    ]);
  });

  it("adds a node to the canvas when a palette item is clicked", () => {
    render(<WorkflowBuilder />);
    expect(screen.queryByTestId("canvas-node-agent")).not.toBeInTheDocument();

    addFromPalette("Agent");

    const node = screen.getByTestId("canvas-node-agent");
    expect(node).toHaveTextContent("Agent");
  });

  it("adds several nodes, one per click", () => {
    render(<WorkflowBuilder />);

    addFromPalette("Start");
    addFromPalette("Agent");
    addFromPalette("End");

    expect(screen.getAllByTestId(/^canvas-node-/)).toHaveLength(3);
    expect(screen.getByTestId("canvas-node-start")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-end")).toBeInTheDocument();
  });

  it("reports every edit through onChange", () => {
    const onChange = vi.fn();
    render(<WorkflowBuilder onChange={onChange} />);

    addFromPalette("Agent");

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as Workflow;
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]).toMatchObject({ id: "agent-1", type: "agent" });
    expect(next.nodes[0]?.position).toEqual({ x: 80, y: 80 });
  });

  it("starts from initialWorkflow when given one", () => {
    const initial: Workflow = {
      ...createEmptyWorkflow(),
      nodes: [
        {
          id: "start-1",
          type: "start",
          name: "Kickoff",
          config: {},
          position: { x: 0, y: 0 },
        },
      ],
    };

    render(<WorkflowBuilder initialWorkflow={initial} />);
    expect(screen.getByTestId("canvas-node-start")).toHaveTextContent(
      "Kickoff",
    );
  });

  it("stays controlled when a workflow prop is supplied", () => {
    const onChange = vi.fn();
    render(<WorkflowBuilder workflow={createEmptyWorkflow()} onChange={onChange} />);

    addFromPalette("Agent");

    // The parent owns the value: nothing renders until it feeds a new one back.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("canvas-node-agent")).not.toBeInTheDocument();
  });

  it("shows validation problems for the current document and clears them", () => {
    render(<WorkflowBuilder />);
    expect(screen.getByText(ValidationCode.MISSING_START_NODE)).toBeVisible();

    addFromPalette("Start");

    expect(
      screen.queryByText(ValidationCode.MISSING_START_NODE),
    ).not.toBeInTheDocument();
  });

  it("flags a freshly added agent node as incomplete", () => {
    render(<WorkflowBuilder />);
    addFromPalette("Start");
    addFromPalette("Agent");

    expect(screen.getByText(ValidationCode.AGENT_MISSING_ROLE)).toBeVisible();
    expect(screen.getByText(ValidationCode.AGENT_MISSING_RUNTIME)).toBeVisible();
    expect(
      screen.getByText(ValidationCode.AGENT_MISSING_INSTRUCTIONS),
    ).toBeVisible();
    expect(screen.getByTestId("canvas-node-agent")).toHaveTextContent(
      "3 issues",
    );
  });

  it("shows the property panel for a node selected from the validation panel", () => {
    render(<WorkflowBuilder />);
    addFromPalette("Agent");

    expect(
      within(
        screen.getByRole("region", { name: "Node properties" }),
      ).getByText(/select a node to edit/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByText(ValidationCode.AGENT_MISSING_ROLE).closest("button")!,
    );

    const panel = within(
      screen.getByRole("region", { name: "Node properties" }),
    );
    expect(panel.getByLabelText("Name")).toHaveValue("Agent");
    expect(panel.getByLabelText("Role")).toHaveValue("");
    expect(panel.getByLabelText("Instructions")).toBeInTheDocument();
  });

  it("shows the property panel for a node clicked on the canvas", () => {
    render(<WorkflowBuilder />);
    addFromPalette("Agent");

    fireEvent.click(screen.getByTestId("canvas-node-agent"));

    const panel = within(
      screen.getByRole("region", { name: "Node properties" }),
    );
    expect(panel.getByLabelText("Name")).toHaveValue("Agent");
    expect(panel.getByLabelText("Runtime")).toHaveValue("");
  });

  it("edits a selected agent node and clears its validation errors", () => {
    render(<WorkflowBuilder />);
    addFromPalette("Start");
    addFromPalette("Agent");
    fireEvent.click(
      screen.getByText(ValidationCode.AGENT_MISSING_ROLE).closest("button")!,
    );

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "developer" },
    });
    fireEvent.change(screen.getByLabelText("Runtime"), {
      target: { value: "claude-code" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Implement the feature." },
    });

    expect(screen.getByLabelText("Role")).toHaveValue("developer");
    expect(screen.getByTestId("validation-count")).toHaveTextContent(
      "No issues",
    );
  });

  it("renames a node and reflects it on the canvas", () => {
    render(<WorkflowBuilder />);
    addFromPalette("Agent");
    fireEvent.click(
      screen.getByText(ValidationCode.AGENT_MISSING_ROLE).closest("button")!,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Reviewer" },
    });

    expect(screen.getByTestId("canvas-node-agent")).toHaveTextContent(
      "Reviewer",
    );
  });
});
