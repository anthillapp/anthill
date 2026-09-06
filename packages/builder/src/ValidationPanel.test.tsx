import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ValidationPanel } from "./ValidationPanel";
import type { Workflow } from "./contracts";
import { addNode, createEmptyWorkflow, createNode } from "./document";
import { ValidationCode } from "./validate";

function validWorkflow(): Workflow {
  return {
    ...createEmptyWorkflow(),
    nodes: [
      { id: "start-1", type: "start", name: "Start", config: {} },
      { id: "end-1", type: "end", name: "End", config: {} },
    ],
    edges: [{ id: "edge-1", source: "start-1", target: "end-1" }],
  };
}

describe("ValidationPanel", () => {
  it("reports a clean workflow", () => {
    render(<ValidationPanel workflow={validWorkflow()} />);
    expect(screen.getByTestId("validation-count")).toHaveTextContent(
      "No issues",
    );
    expect(screen.queryByTestId("validation-errors")).not.toBeInTheDocument();
  });

  it("lists the errors of an intentionally broken workflow", () => {
    const broken: Workflow = {
      ...createEmptyWorkflow(),
      nodes: [{ id: "agent-1", type: "agent", name: "Dev", config: {} }],
      edges: [{ id: "edge-1", source: "ghost", target: "agent-1" }],
    };

    render(<ValidationPanel workflow={broken} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(screen.getByTestId("validation-count")).toHaveTextContent(
      "5 issues",
    );
    expect(screen.getByText(ValidationCode.MISSING_START_NODE)).toBeVisible();
    expect(screen.getByText(ValidationCode.DANGLING_EDGE)).toBeVisible();
    expect(screen.getByText(ValidationCode.AGENT_MISSING_ROLE)).toBeVisible();
  });

  it("uses a pre-computed result when one is given", () => {
    render(
      <ValidationPanel
        workflow={createEmptyWorkflow()}
        result={{ valid: true, errors: [] }}
      />,
    );
    expect(screen.getByTestId("validation-count")).toHaveTextContent(
      "No issues",
    );
  });

  it("selects the offending node when a node-scoped error is clicked", () => {
    const onSelectNode = vi.fn();
    const broken: Workflow = {
      ...createEmptyWorkflow(),
      nodes: [
        { id: "start-1", type: "start", name: "Start", config: {} },
        { id: "approval-1", type: "approval", name: "Gate", config: {} },
      ],
    };

    render(
      <ValidationPanel workflow={broken} onSelectNode={onSelectNode} />,
    );
    fireEvent.click(
      screen.getByText(ValidationCode.APPROVAL_NO_OUTGOING_EDGE).closest(
        "button",
      )!,
    );

    expect(onSelectNode).toHaveBeenCalledWith("approval-1");
  });

  it("updates live as the workflow changes", () => {
    function Harness() {
      const [workflow, setWorkflow] = useState(createEmptyWorkflow());
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setWorkflow((current) =>
                addNode(current, createNode(current, "start")),
              )
            }
          >
            add start
          </button>
          <ValidationPanel workflow={workflow} />
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText(ValidationCode.MISSING_START_NODE)).toBeVisible();

    fireEvent.click(screen.getByText("add start"));

    expect(
      screen.queryByText(ValidationCode.MISSING_START_NODE),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("validation-count")).toHaveTextContent(
      "No issues",
    );
  });
});
