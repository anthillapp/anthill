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
      onSave={vi.fn()}
      onPrompt={onPrompt}
      {...over}
    />,
  );
  return { onPrompt };
}

function handover(model: Partial<HandoverModel> = {}): ToolbarHandover {
  return {
    model: { ...model },
    source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
  };
}

it("hands a workflow made here over from Prompt, beside a selectable tool plaque", () => {
  const { onPrompt } = draw();
  fireEvent.click(screen.getByRole("button", { name: /Prompt/ }));
  expect(onPrompt).toHaveBeenCalled();
  expect(screen.getByText("For Claude Code")).toBeTruthy();
  expect(screen.queryByText("Harness")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Coding tool this prompt is for" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^From / })).toBeNull();
  expect(screen.queryByText("Waiting for you")).toBeNull();
  // The one rename: the graph's pill is about the graph.
  expect(screen.getByText("No problems")).toBeTruthy();
});

it("changes the tool from the plaque", () => {
  const onTarget = vi.fn();
  draw({ onTarget });
  fireEvent.change(screen.getByRole("combobox", { name: "Coding tool this prompt is for" }), {
    target: { value: "codex" },
  });
  expect(onTarget).toHaveBeenCalledWith("codex");
});

/*
 * The Hand-over on a handover would mint a fresh run id and register a second,
 * unrelated run from the same workflow. Prompt stays, as an export: it writes
 * the workflow out for reuse and starts nothing (ANT-265).
 */
it("turns Prompt into an export on a handover, beside a locked plaque", () => {
  const onExport = vi.fn();
  const { onPrompt } = draw({ handover: handover(), onExport });
  const prompt = screen.getByRole("button", { name: /Prompt/ });
  expect(prompt.getAttribute("title")).toContain("Export the workflow");
  fireEvent.click(prompt);
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(onPrompt).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).toBeNull();
  const source = screen.getByRole("button", { name: /From Claude Code/ });
  expect(source.getAttribute("title")).toContain("harness cannot be changed");
});

it("sends a broken handover's Prompt to the problems, not the export", () => {
  const onExport = vi.fn();
  const onToggleProblems = vi.fn();
  draw({ handover: handover(), onExport, onToggleProblems, problemCount: 1 });
  const prompt = screen.getByRole("button", { name: /Prompt/ });
  expect(prompt.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(prompt);
  expect(onExport).not.toHaveBeenCalled();
  expect(onToggleProblems).toHaveBeenCalled();
});

/*
 * The padlock is the design's stroked icon, not the emoji. An emoji padlock is
 * a colour glyph the installed font picks, so it ignored the button's colour
 * and weight and came out a different size on every machine.
 */
it("draws the handover's lock instead of typing an emoji", () => {
  draw({ handover: handover() });
  const source = screen.getByRole("button", { name: /From Claude Code/ });
  expect(source.textContent).not.toContain("\u{1F512}");
  const lock = source.querySelector("svg.lock");
  expect(lock).toBeTruthy();
  expect(lock?.getAttribute("stroke")).toBe("currentColor");
});

/**
 * No approval button on a handover, in any state.
 *
 * `Ready for agent` recorded a decision the user had already given the
 * session in conversation and could hold no work back.
 */
it("offers no approval, whatever the handover is doing", () => {
  for (const model of [
    {},
    { pill: { label: "Bound to revision 1", tone: "bound" as const, title: "t" } },
    { pill: { label: "Running revision 1", tone: "running" as const, title: "t" } },
  ]) {
    cleanup();
    draw({ handover: handover(model) });
    expect(screen.queryByRole("button", { name: /Ready for agent/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
    if (model.pill) expect(screen.getByText(model.pill.label)).toBeTruthy();
  }
});

/**
 * Readiness is the Save button's to say (ANT-116).
 *
 * There were two pills for it — `Draft` and `Ready` — saying in a badge what a
 * blocked or unblocked Save says where the user is about to act.
 */
it("shows no pill on a handover nobody has run", () => {
  draw({ handover: handover() });
  expect(document.querySelector(".wf-pill-handover")).toBeNull();
});

/**
 * The guard the button exists for: so nobody hands a session a graph it
 * cannot follow. A handover has no other way to record a revision, so
 * blocking Save means a broken one is never recorded at all.
 */
it("refuses to save a handover whose graph is broken, and says why", () => {
  const onSave = vi.fn();
  draw({ problemCount: 2, handover: handover(), onSave });
  const save = screen.getByRole("button", { name: "Save" });

  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(save.getAttribute("title")).toContain("2 problems");
  expect(save.getAttribute("title")).toContain("cannot follow");

  fireEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
});

it("saves a handover once the graph is whole", () => {
  const onSave = vi.fn();
  draw({ problemCount: 0, handover: handover(), onSave });
  const save = screen.getByRole("button", { name: "Save" });

  expect(save.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledTimes(1);
});

/**
 * An ordinary workflow is the author's own file, and a half-finished one is
 * a draft rather than a mistake. Only a handover's file is read by a session.
 */
it("never blocks Save on a workflow nobody handed over", () => {
  const onSave = vi.fn();
  draw({ problemCount: 5, onSave });
  const save = screen.getByRole("button", { name: "Save" });

  expect(save.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledTimes(1);
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
  draw({
    problemCount: 2,
    handover: handover({ pill: { label: "Running revision 1", tone: "running", title: "t" } }),
  });
  // Two different claims: whether the graph compiles, and what a session is
  // doing with it. They disagree regularly — this is one of those moments.
  expect(screen.getByText("2 to fix")).toBeTruthy();
  expect(screen.getByText("Running revision 1")).toBeTruthy();
});

it("never offers a control that would start or steer the session", () => {
  draw({ handover: handover() });
  for (const name of [/^run$/i, /^start$/i, /^stop$/i, /^attach$/i, /^watch$/i]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
});
