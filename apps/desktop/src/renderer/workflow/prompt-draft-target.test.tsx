/**
 * ANT-328. A workflow drafted by Codex opened "For Claude Code": the sheet
 * never told the mapping which tool the draft was for, and the mapping's
 * default is Claude Code.
 */

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { INTERPRETERS, WORKFLOWNER_DRAFT_VERSION } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import type { PromptDraftResponse } from "../../shared/ipc.js";
import { PromptToWorkflowSheet } from "./PromptToWorkflowSheet.js";

const codex = INTERPRETERS.find((item) => item.id === "codex")!;

const draft = {
  draftVersion: WORKFLOWNER_DRAFT_VERSION,
  title: "Ship the change",
  agents: [{ id: "dev", name: "Developer" }],
  steps: [
    {
      id: "implement",
      name: "Implement",
      kind: "step",
      agent: "dev",
      action: "agent-step",
      task: "Make the change.",
      outputs: [{ to: "end" }],
    },
  ],
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

it("opens a draft made by Codex as a workflow for Codex", async () => {
  (window as unknown as { anthill: unknown }).anthill = {
    detectInterpreters: vi.fn(async () => [
      {
        id: "codex",
        label: "Codex CLI",
        command: "codex exec --sandbox read-only -",
        boundary: codex.boundary,
        folderBoundary: codex.folderBoundary,
        available: true,
        signedIn: true,
      },
    ]),
    chooseDraftFolder: vi.fn(async () => null),
    draftFromPrompt: vi.fn(
      async (): Promise<PromptDraftResponse> => ({
        ok: true,
        reply: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``,
        command: "codex exec",
      }),
    ),
    cancelPromptDraft: vi.fn(async () => undefined),
    onPromptDraftStage: () => () => undefined,
  };
  const onAccept = vi.fn<(workflow: Workflow) => void>();
  await act(async () => {
    render(<PromptToWorkflowSheet onAccept={onAccept} onCancel={vi.fn()} />);
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Make the change." } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Generate a draft" }));

  await waitFor(() => expect(onAccept).toHaveBeenCalled());
  expect(onAccept.mock.calls[0][0].target).toBe("codex");
});
