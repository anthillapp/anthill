import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { stampWorkflowFormat } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import { WorkflowToolbar, type ToolbarHandover } from "./WorkflowToolbar.js";
import type { HandoverModel } from "./handover.js";

afterEach(cleanup);

const workflow: Workflow = stampWorkflowFormat({
  id: "w",
  name: "Example",
  version: "1",
  target: "claude-code",
  nodes: [],
  edges: [],
});

function draw(over: Partial<Parameters<typeof WorkflowToolbar>[0]> = {}) {
  const onPrompt = vi.fn();
  render(
    <WorkflowToolbar
      workflow={workflow}
      onExit={vi.fn()}
      onRename={vi.fn()}
      onTarget={vi.fn()}
      dirty={false}
      saveStatus={{ kind: "idle" }}
      problemCount={0}
      showProblems={false}
      onToggleProblems={vi.fn()}
      problemsPill={createRef<HTMLButtonElement>() as React.RefObject<HTMLButtonElement>}
      canStepBack={false}
      canStepForward={false}
      onStep={vi.fn()}
      onNew={vi.fn()}
      onOpen={vi.fn()}
      onSave={vi.fn()}
      onPrompt={onPrompt}
      {...over}
    />,
  );
  return { onPrompt };
}

function handover(model: Partial<HandoverModel> = {}, onApprove = vi.fn()): ToolbarHandover {
  return {
    model: {
      pill: { label: "Waiting for you", tone: "waiting", title: "Nothing may start until you approve this revision." },
      primary: { label: "Ready for agent" },
      ...model,
    },
    source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
    onApprove,
    busy: false,
  };
}

it("leaves a workflow nobody handed over exactly as it was", () => {
  const { onPrompt } = draw();
  fireEvent.click(screen.getByRole("button", { name: /Prompt/ }));
  expect(onPrompt).toHaveBeenCalled();
  expect(screen.getByText("Harness")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^From / })).toBeNull();
  expect(screen.queryByText("Waiting for you")).toBeNull();
  // The one rename: the graph's pill is about the graph.
  expect(screen.getByText("No problems")).toBeTruthy();
});

/*
 * Prompt on a handover mints a fresh run id and registers a second, unrelated
 * run from the same workflow — two runs for one piece of work. It is removed
 * rather than demoted, because side by side with the approval the two read as
 * alternatives.
 */
it("offers no Prompt and no harness picker on a handover", () => {
  draw({ handover: handover() });
  expect(screen.queryByRole("button", { name: /Prompt/ })).toBeNull();
  expect(screen.queryByText("Harness")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  const source = screen.getByRole("button", { name: /From Claude Code/ });
  expect(source.getAttribute("title")).toContain("harness cannot be changed");
});

it("records the approval only when the user presses it", () => {
  const onApprove = vi.fn();
  draw({ handover: handover({}, onApprove) });
  const button = screen.getByRole("button", { name: "Ready for agent" });
  expect(onApprove).not.toHaveBeenCalled();
  expect(button.getAttribute("title")).toContain("does not start or control the external session");
  fireEvent.click(button);
  expect(onApprove).toHaveBeenCalledTimes(1);
});

/*
 * Blocked, not hidden, and never merely grey: a control that vanishes teaches
 * nothing, and one that greys out without a reason teaches only that something
 * is wrong somewhere.
 */
it("keeps a blocked approval on screen, with its reason readable", () => {
  const onApprove = vi.fn();
  draw({ handover: handover({ primary: { label: "Ready for agent", blocked: "Save them first." } }, onApprove) });
  const button = screen.getByRole("button", { name: "Ready for agent" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("title")).toBe("Save them first.");
  fireEvent.click(button);
  expect(onApprove).not.toHaveBeenCalled();
});

it("holds nothing in the primary slot where there is no decision to make", () => {
  draw({ handover: handover({ pill: { label: "Running revision 1", tone: "running", title: "t" }, primary: undefined }) });
  expect(screen.queryByRole("button", { name: "Ready for agent" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Prompt/ })).toBeNull();
  expect(screen.getByText("Running revision 1")).toBeTruthy();
});

it("shows the task in the user's own words, from the control that names the source", () => {
  draw({ handover: handover() });
  expect(screen.queryByText("The user's own words")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /From Claude Code/ }));
  expect(screen.getByText("The user's own words")).toBeTruthy();
  expect(screen.getByText("s1")).toBeTruthy();
});

/*
 * Both pills, at once. The graph compiling and the handover's standing are
 * different facts that disagree regularly, and one pill would hide one of them.
 */
it("reports the graph and the handover separately", () => {
  draw({ problemCount: 2, handover: handover() });
  expect(screen.getByText("2 to fix")).toBeTruthy();
  expect(screen.getByText("Waiting for you")).toBeTruthy();
});

it("never offers a control that would start or steer the session", () => {
  draw({ handover: handover() });
  for (const name of [/^run$/i, /^start$/i, /^stop$/i, /^attach$/i, /^watch$/i]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
});
