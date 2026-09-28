/**
 * What the one inspector shows for a block and for a connection.
 *
 * The rule these tests exist for: a problem must be readable on the thing it is
 * about. The Problems index is navigation, not the only home — someone who has
 * selected a block and cannot see why it is marked has to leave it, read a
 * list, and find their way back.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addOutput, agentProfiles, validateWorkflow } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import { AgentEditor } from "./AgentLibrary.js";
import { BlockInspector } from "./BlockInspector.js";
import { OutputInspector } from "./OutputInspector.js";
import { ProblemsPopover, targetOf } from "./ProblemsPopover.js";

/** A workflow with real problems: a step with no action, no task and no agent. */
const workflow: Workflow = {
  id: "workflow-1",
  name: "Broken",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    { id: "build", type: "agent", name: "Build it", config: {} },
    {
      id: "check",
      type: "agent",
      name: "Check it",
      config: { actionKind: "verify", task: "Run the tests", agentId: "agent-1" },
    },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "build" },
    { id: "e2", source: "build", target: "check", label: "built", kind: "next" },
    { id: "e3", source: "check", target: "end", kind: "next" },
  ],
  metadata: { workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Tester" }] } },
};

const validation = validateWorkflow(workflow);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function block(nodeId: string) {
  const onSelectOutput = vi.fn();
  const onEditAgent = vi.fn();
  const onSelectStep = vi.fn();
  render(
    <BlockInspector
      workflow={workflow}
      node={workflow.nodes.find((node) => node.id === nodeId) as Workflow["nodes"][number]}
      onChange={() => undefined}
      onStartLinking={() => undefined}
      onSelectOutput={onSelectOutput}
      onEditAgent={onEditAgent}
      onSelectStep={onSelectStep}
      validation={validation}
    />,
  );
  return { onSelectOutput, onEditAgent, onSelectStep };
}

describe("a selected block", () => {
  it("shows its own problems inline, with severity and code", () => {
    block("build");
    const issues = document.querySelector(".issues") as HTMLElement;
    expect(issues).toBeTruthy();
    expect(within(issues).getAllByText("Must fix").length).toBeGreaterThan(0);
    // The code is what a bug report quotes; it belongs next to the message.
    expect(issues.querySelector(".issue-code")).toBeTruthy();
  });

  it("reads as one column, with no sub-tabs to hide half of it", () => {
    block("check");
    expect(document.querySelector(".segmented")).toBeNull();
    const labels = [...document.querySelectorAll(".section-label")].map((n) => n.textContent);
    // The order answers the questions in the order people ask them.
    expect(labels).toEqual(["Task", "Carried out by", "Connections", "Data", "Limits"]);
  });

  it("says who carries the step out, and offers a way to that agent", () => {
    const { onEditAgent } = block("check");
    expect(screen.getAllByText("Tester").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(onEditAgent).toHaveBeenCalledWith("agent-1");
  });

  it("lists what points at the block as well as what leaves it", () => {
    const { onSelectOutput } = block("check");
    expect(screen.getByText("In – 1")).toBeTruthy();
    expect(screen.getByText("Out – 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Build it/ }));
    expect(onSelectOutput).toHaveBeenCalledWith("build", "e2");
  });

  // ANT-187: the gate's inspector said "In – 0" whatever led into it.
  it("lists what leads into an Approval Gate", () => {
    const gated: Workflow = {
      ...workflow,
      nodes: [...workflow.nodes, { id: "gate", type: "approval", name: "Approve it", config: { prompt: "Go?" } }],
      edges: [...workflow.edges, { id: "e4", source: "check", target: "gate" }],
    };
    render(
      <BlockInspector
        workflow={gated}
        node={gated.nodes.find((node) => node.id === "gate") as Workflow["nodes"][number]}
        onChange={() => undefined}
        onStartLinking={() => undefined}
        onSelectOutput={() => undefined}
        onEditAgent={() => undefined}
        onSelectStep={() => undefined}
        validation={validateWorkflow(gated)}
      />,
    );
    expect(screen.getByText("In – 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check it/ })).toBeTruthy();
  });

  it("says plainly when nothing reaches a step", () => {
    render(
      <BlockInspector
        workflow={{ ...workflow, edges: workflow.edges.filter((edge) => edge.id !== "e2") }}
        node={workflow.nodes[2]}
        onChange={() => undefined}
        onStartLinking={() => undefined}
        onSelectOutput={() => undefined}
        onEditAgent={() => undefined}
        onSelectStep={() => undefined}
        validation={validation}
      />,
    );
    expect(screen.getByText(/Nothing points here yet/)).toBeTruthy();
  });

  it("scrolls to the section an issue's shortcut names", () => {
    block("build");
    const shortcut = screen.getAllByRole("button", { name: /Choose an action|Write the task/ })[0];
    fireEvent.click(shortcut);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("a selected connection", () => {
  it("puts both of its ends within reach", () => {
    const onSelectStep = vi.fn();
    render(
      <OutputInspector
        workflow={workflow}
        nodeId="build"
        outputId="e2"
        onChange={() => undefined}
        onStartLinking={() => undefined}
        onCleared={() => undefined}
        onSelectStep={onSelectStep}
        validation={validation}
      />,
    );

    const ends = document.querySelector(".connection-ends") as HTMLElement;
    fireEvent.click(within(ends).getByRole("button", { name: "Build it" }));
    expect(onSelectStep).toHaveBeenCalledWith("build");
    fireEvent.click(within(ends).getByRole("button", { name: "Check it" }));
    expect(onSelectStep).toHaveBeenCalledWith("check");
  });

  it("marks an unconnected end rather than leaving it blank", () => {
    // Built through the real API, so the fixture cannot drift from the shape
    // the workflow actually stores.
    const { workflow: loose, outputId } = addOutput(workflow, "check", "next");
    render(
      <OutputInspector
        workflow={loose}
        nodeId="check"
        outputId={outputId}
        onChange={() => undefined}
        onStartLinking={() => undefined}
        onCleared={() => undefined}
        validation={validateWorkflow(loose)}
      />,
    );
    // A loose end is drawn as one, rather than as an empty space that reads as
    // a connection nobody bothered to name.
    expect(screen.getByText("not connected")).toBeTruthy();
    expect(document.querySelector(".connection-end.is-loose")).toBeTruthy();
  });
});

describe("the Problems index", () => {
  it("navigates to the thing a problem is about, then gets out of the way", () => {
    const onGo = vi.fn();
    const onClose = vi.fn();
    render(
      <ProblemsPopover
        workflow={workflow}
        issues={validateWorkflow(workflow).errors.map((error) => ({ ...error, severity: "error" }))}
        onGo={onGo}
        onClose={onClose}
      />,
    );

    const rows = document.querySelectorAll(".problems-popover .problem");
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);
    expect(onGo).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("says out loud that it is not the only place to read an issue", () => {
    render(
      <ProblemsPopover workflow={workflow} issues={[]} onGo={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getByText(/also shown on the block or connection/)).toBeTruthy();
  });

  it("derives a row's target from the issue rather than storing it twice", () => {
    expect(targetOf(workflow, { code: "X", message: "m", nodeId: "build", severity: "error" })).toEqual({
      kind: "block",
      nodeId: "build",
    });
    expect(targetOf(workflow, { code: "X", message: "m", edgeId: "e2", severity: "error" })).toEqual({
      kind: "edge",
      nodeId: "build",
      edgeId: "e2",
    });
    // A workflow-wide problem points at nothing, and the row is inert rather than
    // navigating somewhere arbitrary.
    expect(targetOf(workflow, { code: "X", message: "m", severity: "error" })).toBeUndefined();
  });
});

/**
 * The agent profile's place in the panel.
 *
 * ANT-27. This editor was the one inspector that rendered its root straight
 * into the panel's column instead of into `.tab-body`, the scroll region every
 * sibling uses. Without it there was no side padding — the name and role
 * inputs ran to the window's own edge and were clipped there — and no
 * scrolling, so on a profile with several steps the Delete control sat below
 * the panel with no way to reach it.
 *
 * jsdom has no layout engine, so these tests pin the structural contract that
 * produces the layout rather than the pixels; the pixels were checked in the
 * running app at the default window and at its 1024px minimum.
 */
describe("the agent profile inspector", () => {
  const withAgent: Workflow = {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === "build"
        ? { ...node, config: { ...node.config, agentId: "agent-1" } }
        : node,
    ),
  };

  function editor(target: Workflow = withAgent) {
    const onChange = vi.fn();
    render(
      <AgentEditor
        workflow={target}
        profile={agentProfiles(target)[0]}
        onChange={onChange}
        onSelect={vi.fn()}
        onSelectStep={vi.fn()}
      />,
    );
    return { onChange };
  }

  it("lives in the panel's scroll region, like every other inspector", () => {
    editor();
    const root = document.querySelector(".agent-editor") as HTMLElement;
    expect(root).toBeTruthy();
    // `.tab-body` is what carries the panel's padding and its overflow; being
    // in the class list is the whole of the contract.
    expect(root.classList.contains("tab-body")).toBe(true);
  });

  it("keeps the delete control inside that scroll region", () => {
    editor();
    const root = document.querySelector(".agent-editor") as HTMLElement;
    const remove = screen.getByRole("button", { name: "Delete agent" });
    expect(root.contains(remove)).toBe(true);
  });

  it("keeps the way back inside it too, so scrolling cannot strand it", () => {
    const onChange = vi.fn();
    render(
      <AgentEditor
        workflow={withAgent}
        profile={agentProfiles(withAgent)[0]}
        onChange={onChange}
        onSelect={vi.fn()}
        onSelectStep={vi.fn()}
        backTo={{ label: "Build it", go: vi.fn() }}
      />,
    );
    const root = document.querySelector(".agent-editor") as HTMLElement;
    const back = screen.getByRole("button", { name: /Back to Build it/ });
    expect(root.contains(back)).toBe(true);
    expect(back.classList.contains("back-link")).toBe(true);
  });

  it("renders long content as wrapping prose, not as one unbreakable line", () => {
    const longName = "A".repeat(40) + " " + "B".repeat(40);
    const wordy: Workflow = {
      ...withAgent,
      nodes: withAgent.nodes.map((node) =>
        node.id === "build" ? { ...node, name: longName } : node,
      ),
    };
    editor(wordy);

    // The step name appears as a link in "Used by", and that link is the one
    // place `button.link`'s nowrap would have pushed the panel sideways.
    const use = screen.getByRole("button", { name: longName });
    expect(use.classList.contains("link")).toBe(true);
    expect(use.closest(".agent-uses")).toBeTruthy();
  });

  it("still refuses to delete an agent a step is using", () => {
    const { onChange } = editor();
    const remove = screen.getByRole("button", { name: "Delete agent" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
  });
});
