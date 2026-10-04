/**
 * The optional project folder on "Workflow from a prompt" (ANT-67).
 *
 * What has to hold: the folder never gates Continue, it survives the trip to
 * step 2 and back, step 2 then shows the command and boundary that will really
 * apply, and a folder that has gone sends the author back to the block with
 * nothing run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { INTERPRETERS } from "@anthill/workflow";

import type { DraftFolder, PromptDraftRequest, PromptDraftResponse } from "../../shared/ipc.js";
import { PromptToWorkflowSheet } from "./PromptToWorkflowSheet.js";

const ACME: DraftFolder = { path: "/Users/me/code/acme-web", displayPath: "~/code/acme-web" };
const claude = INTERPRETERS.find((item) => item.id === "claude-code")!;

function stubAnthill(options: {
  pick?: Array<DraftFolder | null>;
  draft?: (request: PromptDraftRequest) => Promise<PromptDraftResponse>;
} = {}) {
  const picks = [...(options.pick ?? [ACME])];
  const chooseDraftFolder = vi.fn(async () => (picks.length > 1 ? picks.shift()! : picks[0] ?? null));
  const draftFromPrompt = vi.fn(
    options.draft ??
      (async (): Promise<PromptDraftResponse> => ({ ok: false, cancelled: true, command: "" })),
  );
  (window as unknown as { anthill: unknown }).anthill = {
    detectInterpreters: vi.fn(async () => [
      {
        id: "claude-code",
        label: "Claude Code",
        command: 'claude -p --output-format text --tools "" --strict-mcp-config',
        boundary: claude.boundary,
        folderBoundary: claude.folderBoundary,
        available: true,
        signedIn: true,
      },
    ]),
    chooseDraftFolder,
    draftFromPrompt,
    cancelPromptDraft: vi.fn(async () => undefined),
    onPromptDraftStage: () => () => undefined,
  };
  return { chooseDraftFolder, draftFromPrompt };
}

/** Mounted once the installed CLIs have been looked for, as the screen does first. */
async function mount() {
  await act(async () => {
    render(<PromptToWorkflowSheet onAccept={vi.fn()} onCancel={vi.fn()} />);
  });
}

function write(text = "Build a login page and review it.") {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the project folder block", () => {
  it("is optional: Continue waits on the prompt, not the folder", async () => {
    stubAnthill();
    await mount();
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    write();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", false);
  });

  it("shows the chosen folder with ~, then lets it be changed or removed", async () => {
    const { chooseDraftFolder } = stubAnthill();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText("~/code/acme-web");
    expect(screen.getByText("Project folder · read-only")).toBeTruthy();
    expect(chooseDraftFolder).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("~/code/acme-web")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose folder…" })).toBeTruthy();
  });

  it("keeps the folder when the picker is cancelled", async () => {
    stubAnthill({ pick: [ACME, null] });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText("~/code/acme-web");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(screen.getByText("~/code/acme-web")).toBeTruthy());
  });
});

describe("step 2 with a folder", () => {
  async function toStepTwo() {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText("~/code/acme-web");
    write();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(claude.folderBoundary);
  }

  it("names the folder under the prompt, and runs the command that reads it", async () => {
    stubAnthill();
    await toStepTwo();
    expect(screen.getByText("Folder:")).toBeTruthy();
    expect(
      screen.getByText(
        "cd ~/code/acme-web && claude -p --output-format text --tools Read,Glob,Grep --restricted --strict-mcp-config",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/may read files in ~\/code\/acme-web/)).toBeTruthy();
  });

  it("keeps the folder through Edit and back", async () => {
    stubAnthill();
    await toStepTwo();
    fireEvent.click(screen.getByRole("button", { name: "Back to the prompt" }));
    expect(screen.getByText("~/code/acme-web")).toBeTruthy();
  });

  it("asks main to read the folder, and says so in the instruction", async () => {
    const { draftFromPrompt } = stubAnthill();
    await toStepTwo();
    fireEvent.click(screen.getByRole("button", { name: "Generate a draft" }));
    await waitFor(() => expect(draftFromPrompt).toHaveBeenCalled());
    const request = draftFromPrompt.mock.calls[0][0];
    expect(request.folder).toBe(ACME.path);
    expect(request.instruction).toContain("## Project context");
  });

  it("sends the author back to the block when the folder has gone", async () => {
    stubAnthill({
      draft: async () => ({
        ok: false,
        folderMissing: true,
        error: "This folder can't be found. Choose it again or remove it.",
        command: "",
      }),
    });
    await toStepTwo();
    fireEvent.click(screen.getByRole("button", { name: "Generate a draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This folder can't be found. Choose it again or remove it.");
    expect(screen.getByText("Describe the work")).toBeTruthy();
    // Removing the folder clears what was said about it.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("step 2 without a folder", () => {
  it("is what it was: no folder line, the no-tools command, no project context", async () => {
    const { draftFromPrompt } = stubAnthill();
    await mount();
    write();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(claude.boundary);
    expect(screen.queryByText("Folder:")).toBeNull();
    expect(screen.getByText('claude -p --output-format text --tools "" --strict-mcp-config')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate a draft" }));
    await waitFor(() => expect(draftFromPrompt).toHaveBeenCalled());
    const request = draftFromPrompt.mock.calls[0][0];
    expect(request).not.toHaveProperty("folder");
    expect(request.instruction).not.toContain("Project context");
  });
});
