import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { NodePropertyPanel } from "./NodePropertyPanel";
import type { Workflow } from "./contracts";
import { createEmptyWorkflow, findNode } from "./document";

function workflowWithNodes(): Workflow {
  return {
    ...createEmptyWorkflow(),
    nodes: [
      {
        id: "agent-1",
        type: "agent",
        name: "Developer",
        config: { role: "developer", instructions: "Ship it." },
      },
      { id: "command-1", type: "command", name: "Run tests", config: {} },
      { id: "start-1", type: "start", name: "Start", config: {} },
    ],
  };
}

/** Stateful harness so typing behaves like it does inside WorkflowBuilder. */
function Harness({
  initial,
  selectedNodeId,
  onChange,
}: {
  initial: Workflow;
  selectedNodeId: string | null;
  onChange?: (next: Workflow) => void;
}) {
  const [workflow, setWorkflow] = useState(initial);
  return (
    <NodePropertyPanel
      workflow={workflow}
      selectedNodeId={selectedNodeId}
      onChange={(next) => {
        setWorkflow(next);
        onChange?.(next);
      }}
    />
  );
}

describe("NodePropertyPanel", () => {
  it("prompts to select a node when nothing is selected", () => {
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it("prompts to select a node when the selection is stale", () => {
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="deleted-1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it("renders the agent field set with current values", () => {
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="agent-1"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Developer");
    expect(screen.getByLabelText("Role")).toHaveValue("developer");
    expect(screen.getByLabelText("Runtime")).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Ship it.");
    expect(screen.getByLabelText("Working directory")).toHaveValue("");
    expect(screen.getByLabelText("Success criteria")).toHaveValue("");
  });

  it("reports config edits through onChange", () => {
    const onChange = vi.fn();
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="agent-1"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Runtime"), {
      target: { value: "claude-code" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as Workflow;
    expect(findNode(next, "agent-1")?.config).toEqual({
      role: "developer",
      instructions: "Ship it.",
      runtime: "claude-code",
    });
  });

  it("edits the multi-line instructions field", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={workflowWithNodes()}
        selectedNodeId="agent-1"
        onChange={onChange}
      />,
    );

    const textarea = screen.getByLabelText("Instructions");
    fireEvent.change(textarea, { target: { value: "Line one\nLine two" } });

    expect(textarea).toHaveValue("Line one\nLine two");
    const next = onChange.mock.calls.at(-1)![0] as Workflow;
    expect(findNode(next, "agent-1")?.config.instructions).toBe(
      "Line one\nLine two",
    );
  });

  it("renames a node without touching its config", () => {
    const onChange = vi.fn();
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="agent-1"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Reviewer" },
    });

    const next = onChange.mock.calls[0]![0] as Workflow;
    expect(findNode(next, "agent-1")?.name).toBe("Reviewer");
    expect(findNode(next, "agent-1")?.config).toEqual({
      role: "developer",
      instructions: "Ship it.",
    });
  });

  it("keeps successive edits (each edit builds on the previous workflow)", () => {
    render(
      <Harness initial={workflowWithNodes()} selectedNodeId="agent-1" />,
    );

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "reviewer" },
    });
    fireEvent.change(screen.getByLabelText("Runtime"), {
      target: { value: "codex" },
    });

    expect(screen.getByLabelText("Role")).toHaveValue("reviewer");
    expect(screen.getByLabelText("Runtime")).toHaveValue("codex");
  });

  it("shows a minimal panel for non-agent node types", () => {
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="command-1"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Run tests");
    expect(screen.getByLabelText("Command")).toBeInTheDocument();
    expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  });

  it("shows only a name field for start nodes", () => {
    render(
      <NodePropertyPanel
        workflow={workflowWithNodes()}
        selectedNodeId="start-1"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Start");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
