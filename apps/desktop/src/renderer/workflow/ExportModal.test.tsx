/**
 * Export: a handed-over workflow written out for reuse (ANT-265).
 *
 * What matters is what it does not do. It writes the agent files and a
 * Prompt.md, and nothing else: no run is registered, nothing is copied, and
 * the Prompt.md carries no run marker — a reuse with this session's marker
 * would claim this session's run.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import type { ExportWorkflowRequest, ExportWorkflowResponse } from "../../shared/ipc.js";

import { ExportModal, PROMPT_FILE } from "./ExportModal.js";
import { COPIED_MS, RUN_TOOL_KEY } from "./RunAgainCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROOT = "/Users/someone/project";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Read the note",
  version: "1",
  target: "claude-code",
  brief: {
    goal: "Read note.txt and say what it contains.",
    doneCriteria: ["The contents of note.txt have been reported."],
  },
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    {
      id: "read",
      type: "agent",
      name: "Read the note",
      config: {
        actionKind: "agent-step",
        task: "Read note.txt in the working directory.",
        agentId: "agent-1",
        outputs: [{ id: "o1", label: "Done", kind: "next" }],
      },
    },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "read" },
    { id: "e2", source: "read", target: "end", kind: "next" },
  ],
  metadata: {
    workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Reader" }], runRoot: ROOT },
  },
};

function stub(response: ExportWorkflowResponse = { ok: true, directory: ROOT, written: [] }) {
  const exportWorkflow = vi.fn(async (_request: ExportWorkflowRequest) => response);
  const liveObserve = vi.fn();
  const chooseRunFolder = vi.fn(async () => "/Users/someone/elsewhere");
  vi.stubGlobal("anthill", { exportWorkflow, liveObserve, chooseRunFolder });
  return { exportWorkflow, liveObserve, chooseRunFolder };
}

it("writes the agent files and a marker-free Prompt.md, and starts nothing", async () => {
  const { exportWorkflow, liveObserve } = stub();
  render(<ExportModal workflow={workflow} onClose={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "Export this workflow" })).toBeTruthy();
  expect(screen.getByText(".claude/agents/reader.md")).toBeTruthy();
  expect(screen.getByText("1 step")).toBeTruthy();
  expect(screen.getByText(ROOT)).toBeTruthy();
  expect(screen.getByText("2 files")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Export" }));

  await waitFor(() => expect(screen.getByRole("heading", { name: "Exported" })).toBeTruthy());
  const request = exportWorkflow.mock.calls[0]![0];
  expect(request.root).toBe(ROOT);
  expect(request.files.map((file) => file.path)).toEqual([".claude/agents/reader.md", PROMPT_FILE]);
  const prompt = request.files.find((file) => file.path === PROMPT_FILE)!.content;
  expect(prompt).toContain("Read note.txt");
  expect(prompt).not.toMatch(/anthill-run-id|anthill-nonce|ANTHILL_STEP/i);
  expect(liveObserve).not.toHaveBeenCalled();
  expect(screen.getByText(`2 files written to ${ROOT}`)).toBeTruthy();
});

it("writes only what is ticked, and refuses when nothing is", async () => {
  const { exportWorkflow } = stub();
  render(<ExportModal workflow={workflow} onClose={vi.fn()} />);

  fireEvent.click(screen.getByRole("checkbox", { name: /Agent files/ }));
  expect(screen.queryByText(".claude/agents/reader.md")).toBeNull();
  expect(screen.getByText("1 file")).toBeTruthy();

  fireEvent.click(screen.getByRole("checkbox", { name: /Prompt\.md/ }));
  const exportButton = screen.getByRole("button", { name: "Export" });
  expect(exportButton.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(exportButton);
  expect(exportWorkflow).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("checkbox", { name: /Prompt\.md/ }));
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(exportWorkflow).toHaveBeenCalled());
  expect(exportWorkflow.mock.calls[0]![0].files.map((file) => file.path)).toEqual([PROMPT_FILE]);
});

it("writes into the folder chosen with Change…", async () => {
  const { exportWorkflow } = stub({ ok: true, directory: "/Users/someone/elsewhere", written: [] });
  render(<ExportModal workflow={workflow} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  await waitFor(() => expect(screen.getByText("/Users/someone/elsewhere")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(exportWorkflow).toHaveBeenCalled());
  expect(exportWorkflow.mock.calls[0]![0].root).toBe("/Users/someone/elsewhere");
});

it("says what went wrong when the write fails, and stays open to try again", async () => {
  stub({ ok: false, error: "Disk full.", rolledBack: true });
  render(<ExportModal workflow={workflow} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Disk full."));
  expect(screen.getByText("Nothing was written")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Export this workflow" })).toBeTruthy();
});

it("closes on Escape, on the backdrop and on Done", async () => {
  stub();
  const onClose = vi.fn();
  const { container } = render(<ExportModal workflow={workflow} onClose={onClose} />);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(container.querySelector(".modal-scrim")!);
  expect(onClose).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledTimes(3);
});

/*
 * Run it again from your coding tool (ANT-281): the command the plugin's `run`
 * takes, and the path it reads. Copy only — pressing either starts nothing.
 */
const PATH = "~/Library/Application Support/@anthill/desktop/exchange/workflows/workflow-1/workflow.json";

function clipboard() {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

it("offers the run command for Claude Code by default, quoted as it is copied", async () => {
  window.localStorage.removeItem(RUN_TOOL_KEY);
  const { liveObserve, exportWorkflow } = stub();
  const writeText = clipboard();
  render(<ExportModal workflow={workflow} workflowPath={PATH} onClose={vi.fn()} />);

  expect(screen.getByText("Agent files, Prompt.md and a run command, for running it again.")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Claude Code" }).getAttribute("aria-selected")).toBe("true");
  const shown = screen.getByTestId("run-command");
  expect(shown.textContent).toBe(`/anthill:workflow run "${PATH}"`);
  expect(shown.getAttribute("title")).toBe(`/anthill:workflow run "${PATH}"`);

  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`/anthill:workflow run "${PATH}"`));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(PATH));
  // One "Copied" at a time: the command's button is back to itself.
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy());
  expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);

  expect(liveObserve).not.toHaveBeenCalled();
  expect(exportWorkflow).not.toHaveBeenCalled();
});

it("switches the verb to Codex's, and remembers the choice for next time", () => {
  window.localStorage.removeItem(RUN_TOOL_KEY);
  stub();
  const first = render(<ExportModal workflow={workflow} workflowPath={PATH} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
  expect(screen.getByTestId("run-command").textContent).toBe(`$anthill run "${PATH}"`);
  first.unmount();

  render(<ExportModal workflow={workflow} workflowPath={PATH} onClose={vi.fn()} />);
  expect(screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
  window.localStorage.removeItem(RUN_TOOL_KEY);
});

it("lets go of Copied after a moment", async () => {
  vi.useFakeTimers();
  try {
    stub();
    clipboard();
    render(<ExportModal workflow={workflow} workflowPath={PATH} onClose={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(COPIED_MS));
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the card after Export, with the new note", async () => {
  stub();
  render(<ExportModal workflow={workflow} workflowPath={PATH} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Exported" })).toBeTruthy());
  expect(screen.getByTestId("run-command")).toBeTruthy();
  expect(screen.getByText(/Each run is followed as a new session in Anthill\./)).toBeTruthy();
});

it("offers no command for a workflow with no file", () => {
  stub();
  render(<ExportModal workflow={workflow} onClose={vi.fn()} />);
  expect(screen.queryByTestId("run-command")).toBeNull();
  expect(screen.getByText("Agent files and Prompt.md, for running it again later.")).toBeTruthy();
});
