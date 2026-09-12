/**
 * The handover, and the order it cannot get wrong.
 *
 * Two guarantees live here. The pending run must exist before the prompt
 * reaches the clipboard — once the text is out of Anthill, Anthill has no
 * further say in what happens to it, so registering afterwards would leave a
 * window in which a session could start with nothing to match it against. And
 * the agent files must be written before that same moment, because a harness
 * fixes its list of callable agents when its session starts: the copy is the
 * last instant they can be in place.
 *
 * The screen is a sequence for exactly that reason, so most of what follows is
 * about the sequence holding.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import { parseMarker } from "@anthill/live";

import type { ExportWorkflowResponse } from "../../shared/ipc.js";

import { PromptModal } from "./PromptModal.js";

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
  metadata: { workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Reader" }] } },
};

/** The same workflow for someone who has already named a repository. */
const withRoot = (root: string): Workflow => ({
  ...workflow,
  metadata: {
    workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Reader" }], runRoot: root },
  },
});

const valid = { valid: true, errors: [] };

const CHOSEN = "/Users/someone/project";

/** A harness whose hooks are installed, run, and have delivered. */
function harness(over: Record<string, unknown> = {}) {
  return {
    id: "claude-code" as const,
    label: "Claude Code",
    cliCommand: "claude",
    cliAvailable: true,
    hookInstalled: true,
    hookEntriesPresent: true,
    hookLastEventAt: "2026-09-04T10:00:00.000Z",
    configPath: "/tmp/home/.claude/settings.json",
    hookHandlerPath: "/tmp/anthill/live-hook-handler.js",
    installerAction: "No shell installer command is run.",
    installCommand: "node handler PreToolUse",
    hookCommands: ["node handler SessionStart", "node handler PreToolUse"],
    eventCategories: ["Session start", "Tool start"],
    localDataBoundary: "Events remain local.",
    changes: ["Back up config before changing it."],
    ...over,
  };
}

function stub(
  setup: Record<string, unknown> = harness(),
  agentSupport: "supported" | "unsupported" | "unknown" = "supported",
) {
  const order: string[] = [];
  const copied: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const listeners: ((snapshot: { runs: unknown[]; capabilities: unknown[] }) => void)[] = [];
  const api = {
    chooseRunFolder: vi.fn(async (): Promise<string | null> => CHOSEN),
    codexModels: vi.fn(async () => ({ models: [], agentSupport })),
    capabilities: vi.fn(async () => ({ contract: 12, channels: [] })),
    liveSetupStatus: vi.fn(async () => ({ dismissed: true, trigger: "", harnesses: [setup] })),
    liveSetupInstall: vi.fn(async () => ({
      ok: true as const,
      message: "installed",
      status: { dismissed: true, trigger: "", harnesses: [harness()] },
    })),
    onLiveSnapshot: vi.fn((listener: (snapshot: { runs: unknown[]; capabilities: unknown[] }) => void) => {
      listeners.push(listener);
      return () => undefined;
    }),
    liveObserve: vi.fn(async (request: Record<string, unknown>) => {
      order.push("observe");
      requests.push(request);
      return { runs: [], capabilities: [] };
    }),
    exportWorkflow: vi.fn(async (): Promise<ExportWorkflowResponse> => {
      order.push("files");
      return { ok: true, directory: CHOSEN, written: [] };
    }),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        order.push("clipboard");
        copied.push(text);
      }),
    },
  });
  return { api, order, copied, requests, listeners };
}

afterEach(() => {
  delete (window as unknown as { anthill?: unknown }).anthill;
});

/** Renders the modal, wherever the workflow's own state starts it. */
function open(view: Workflow = withRoot(CHOSEN), onRunRoot = vi.fn(), onClose = () => undefined) {
  render(
    <PromptModal
      workflow={view}
      validation={valid}
      onClose={onClose}
      onRunRoot={onRunRoot}
    />,
  );
  return onRunRoot;
}

/**
 * Walk to the handover step.
 *
 * Live Observation sits between the files and the copy now, so a test about
 * the copy has to pass through it the way a person does.
 */
async function toHandover() {
  const primary = await screen.findByRole("button", { name: "Continue" });
  fireEvent.click(primary);
  await screen.findByRole("heading", { name: /^Hand over to|^Paste it into/ });
}

const copyButton = () => screen.getByRole("button", { name: /^Copy prompt$|^Copy again$|^Try that folder again$/ });

/**
 * A workflow that genuinely produces no agent files.
 *
 * Targeting Codex used to be enough, because Anthill believed Codex had no
 * custom agents and inlined every step into one prompt. Codex does have them
 * (ANT-51), so both harnesses write files now and "no agent files" means what
 * it says: a workflow with no agent steps in it at all.
 */
function withoutAgents(): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.id !== "read"),
    edges: [{ id: "e1", source: "start", target: "end" }],
  };
}

describe("the handover", () => {
  it("registers the run before the prompt reaches the clipboard", async () => {
    const { api, order } = stub();
    open();
    await toHandover();

    fireEvent.click(copyButton());
    await waitFor(() => expect(order).toEqual(["files", "observe", "clipboard"]));
    expect(api.liveObserve).toHaveBeenCalledTimes(1);
  });

  it("copies a prompt carrying the same marker the screen displayed", async () => {
    const { copied, requests } = stub();
    open();
    await toHandover();

    const shown = screen.getByText(/^ANT-/).textContent as string;
    fireEvent.click(copyButton());
    await waitFor(() => expect(copied).toHaveLength(1));

    const marker = parseMarker(copied[0]);
    expect(marker?.runId).toBe(shown);
    expect(requests[0]).toMatchObject({
      anthillRunId: shown,
      selectedCli: "claude-code",
      workflowId: "workflow-1",
      workflowName: "Read the note",
    });
  });

  it("sends a hash of the prompt, never the prompt itself", async () => {
    const { copied, requests } = stub();
    open();
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(copied).toHaveLength(1));

    const request = requests[0] as { bootstrapPromptHash: string };
    expect(request.bootstrapPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(request)).not.toContain("Read note.txt");
  });

  it("has no start, run, attach, listen, or watch control", async () => {
    stub();
    open();
    await toHandover();
    const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    for (const forbidden of ["Start", "Run ", "Attach", "Listen", "Watch", "Join"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });

  it("says plainly that Anthill does not run the prompt", async () => {
    stub();
    open();
    await toHandover();
    expect(screen.getByText(/Anthill does not run it/)).toBeTruthy();
  });

  it("keeps the marker's promise about what it carries", async () => {
    stub();
    open();
    await toHandover();
    expect(screen.getByText("No secrets, tokens, or file paths.")).toBeTruthy();
  });

  it("keeps the prompt one click away rather than on the screen", async () => {
    stub();
    open();
    await toHandover();
    expect(document.querySelector(".handover-preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Inspect the prompt/ }));
    expect(document.querySelector(".handover-preview")?.textContent).toContain("Read note.txt");
  });

  it("offers nothing to copy while the workflow is broken", () => {
    stub();
    render(
      <PromptModal
        workflow={workflow}
        validation={{ valid: false, errors: [{ code: "X", message: "broken" }] }}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
  });

  it("closes on the backdrop but not on a click inside the panel", () => {
    stub();
    const onClose = vi.fn();
    render(<PromptModal workflow={withRoot(CHOSEN)} validation={valid} onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector(".modal-scrim") as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The sequence.
 *
 * A folder has to be named before files can be written, and the files have to
 * be written before the prompt is worth copying. The screen was one page that
 * showed both at once, where the order — the only part that matters — was
 * invisible.
 */
describe("the three steps", () => {
  it("opens on the folder when it does not know one", () => {
    stub();
    open(workflow);
    expect(screen.getByRole("heading", { name: "Set up the agent files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("says which files it will write and why they cannot wait", () => {
    stub();
    open(workflow);
    expect(screen.getByText(".claude/agents/*.md")).toBeTruthy();
    expect(screen.getByText(/fixes its list of callable agents at start-up/)).toBeTruthy();
    expect(within(document.querySelector(".handover-files") as HTMLElement).getByText(
      ".claude/agents/reader.md",
    )).toBeTruthy();
  });

  it("advances once a folder is chosen, and returns on Change", async () => {
    stub();
    open(workflow);

    fireEvent.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    // The folder hands over to observation, and observation to the copy.
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    await toHandover();
    expect(screen.getByText(CHOSEN)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Change…" })[0]);
    expect(screen.getByRole("heading", { name: "Set up the agent files" })).toBeTruthy();
  });

  it("stays on the folder when the author closes the picker", async () => {
    const { api } = stub();
    api.chooseRunFolder.mockResolvedValueOnce(null);
    open(workflow);

    fireEvent.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    await waitFor(() => expect(api.chooseRunFolder).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Set up the agent files" })).toBeTruthy();
  });

  it("hands the chosen repository back to be remembered", async () => {
    stub();
    const onRunRoot = open(workflow);
    fireEvent.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    await waitFor(() => expect(onRunRoot).toHaveBeenCalledWith(CHOSEN));
  });

  it("does not re-remember a repository it was given", async () => {
    stub();
    const onRunRoot = open();
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(screen.getByText(/agent file written/)).toBeTruthy());
    expect(onRunRoot).not.toHaveBeenCalled();
  });

  it("skips the files step for a workflow with no agent files", async () => {
    // Not step 1 with empty regions: there is nothing to place, so the flow
    // starts at observation and the pill for step 1 is not offered.
    stub();
    open(withoutAgents());
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    expect(screen.queryByText("1 Files")).toBeNull();
    expect(screen.getByText("2 Live")).toBeTruthy();

    await toHandover();
    expect(document.querySelector(".handover-receipt")).toBeNull();
  });

  /*
   * ANT-51. A Codex too old for project-scoped custom agents reads none of the
   * files Anthill just wrote, so every step runs on the session's own model.
   * Said before the prompt leaves, because afterwards the only symptom is a
   * run that looks subtly wrong.
   */
  it("warns before the handover when the installed Codex will ignore the files", async () => {
    stub(harness(), "unsupported");
    open({ ...withRoot(CHOSEN), target: "codex" });
    await toHandover();

    // The sentence carries a <code> element, so it is matched on the element
    // rather than on one of its text nodes.
    expect(
      await screen.findByText(
        (_text, element) =>
          element?.tagName === "P" &&
          (element.textContent ?? "").includes("does not read .codex/agents"),
      ),
    ).toBeTruthy();
  });

  it("says nothing of the sort when the installed Codex does read them", async () => {
    stub(harness(), "supported");
    open({ ...withRoot(CHOSEN), target: "codex" });
    await toHandover();
    expect(screen.queryByText(/does not read/)).toBeNull();
  });

  /* A question that could not be answered is not a "no". */
  it("stays quiet when the CLI could not be asked", async () => {
    stub(harness(), "unknown");
    open({ ...withRoot(CHOSEN), target: "codex" });
    await toHandover();
    expect(screen.queryByText(/does not read/)).toBeNull();
  });

  it("names the CLI from the harness, not from the file count", async () => {
    // A workflow that writes nothing is still handed to the harness it targets.
    stub();
    open({ ...withoutAgents(), target: "codex" });
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    await toHandover();
    expect(screen.getByRole("heading", { name: "Hand over to OpenAI Codex CLI" })).toBeTruthy();
  });
});

/**
 * What happens to somebody's repository, and what is said about it.
 */
describe("writing the agent files", () => {
  it("writes them into the named folder, before the clipboard", async () => {
    const { api, order } = stub();
    open();
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(order).toContain("clipboard"));
    expect(order.indexOf("files")).toBeLessThan(order.indexOf("clipboard"));
    expect((api.exportWorkflow.mock.calls[0] as unknown[])[0]).toMatchObject({ root: CHOSEN });
  });

  it("reports the write, and turns the instruction into a status", async () => {
    stub();
    open();
    await toHandover();
    fireEvent.click(copyButton());
    await screen.findByRole("heading", { name: "Paste it into Claude Code" });
    expect(screen.getByText(/1 agent file written/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy again" })).toBeTruthy();
  });

  it("still copies when the write fails, and says what failed", async () => {
    // A half-written folder is worth naming; withholding the prompt over it
    // would leave the author with nothing at all.
    const { api, order } = stub();
    api.exportWorkflow.mockResolvedValueOnce({ ok: false, error: "disk full" });
    open();
    await toHandover();
    fireEvent.click(copyButton());

    await waitFor(() => expect(order).toContain("clipboard"));
    expect(screen.getByText("disk full")).toBeTruthy();
    expect(screen.getByText("Could not write the agent files")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try that folder again" })).toBeTruthy();
  });

  it("lets the author copy without them, rather than refusing", async () => {
    // Declining a folder is a real answer for a prompt going to a machine
    // Anthill cannot see. The cost is on the button, not in a dead end.
    const { api, order } = stub();
    open(workflow);

    fireEvent.click(screen.getByRole("button", { name: "Copy without agent files" }));
    await waitFor(() => expect(order).toContain("clipboard"));
    expect(api.exportWorkflow).not.toHaveBeenCalled();
  });

  it("says what copying without them costs, and leaves the folder step", async () => {
    // Pressing a button and having the screen say nothing back is its own bug.
    stub();
    open(workflow);

    fireEvent.click(screen.getByRole("button", { name: "Copy without agent files" }));
    // Step 1 also says a workflow without the files "runs as one agent", so
    // this waits on the footer's whole sentence — a looser match resolves
    // against the step the copy is supposed to leave.
    await screen.findByText("Copied without the agent files — that session runs as one agent.");
    expect(document.querySelector(".handover-receipt")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("writes nothing for a workflow with no agent files", async () => {
    const { api, order } = stub();
    open(withoutAgents());
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(order).toContain("clipboard"));
    expect(api.exportWorkflow).not.toHaveBeenCalled();
  });
});

/**
 * Step 2: offering to watch the session about to start.
 *
 * The hooks have the same deadline the agent files have — both are read when
 * the session starts — which is why this is in the flow at all rather than
 * beside Save.
 */
describe("enabling live observation", () => {
  const notInstalled = () => harness({ hookEntriesPresent: false, hookInstalled: false, hookLastEventAt: undefined });
  const missing = () => harness({ cliAvailable: false, hookEntriesPresent: false, hookInstalled: false, hookLastEventAt: undefined });
  const untested = () => harness({ hookLastEventAt: undefined });
  const broken = () => harness({ hookInstalled: false, hookProblem: "The hook command exited with 127." });

  it("states the boundary before it asks for anything", async () => {
    stub(notInstalled());
    open();
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    expect(
      screen.getByText(/does not run it, control it, or answer it/),
    ).toBeTruthy();
  });

  it("offers to install when nothing is set up", async () => {
    const { api } = stub(notInstalled());
    open();
    const enable = await screen.findAllByRole("button", { name: "Enable Live Observation" });
    fireEvent.click(enable[enable.length - 1]);
    await waitFor(() => expect(api.liveSetupInstall).toHaveBeenCalledWith("claude-code"));
  });

  it("never installs anything by being opened", async () => {
    const { api } = stub(notInstalled());
    open();
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    expect(api.liveSetupInstall).not.toHaveBeenCalled();
  });

  it("does not ask again once it is set up", async () => {
    stub();
    open();
    await screen.findByText("Live Observation is ready");
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enable|Retry/ })).toBeNull();
    expect(screen.getByText("Already set up — nothing is written again.")).toBeTruthy();
  });

  /**
   * The defect this design exists to prevent: a single "settled" predicate
   * dropped `unavailable` into the installing branch, so a button reading
   * Continue installed hooks for a CLI Anthill had just said was not there.
   */
  it("installs nothing for a CLI it could not find", async () => {
    const { api } = stub(missing());
    open();
    await screen.findByText("This CLI was not found on this machine");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: /^Hand over to/ });
    expect(api.liveSetupInstall).not.toHaveBeenCalled();
  });

  it("never shows two buttons both reading Continue", async () => {
    for (const setup of [notInstalled(), missing(), untested(), harness()]) {
      cleanup();
      stub(setup);
      open();
      await screen.findByRole("heading", { name: "Enable Live Observation" });
      expect(screen.queryAllByRole("button", { name: "Continue" }).length).toBeLessThan(2);
    }
  });

  it("always offers a way past where it offers to install", async () => {
    stub(notInstalled());
    open();
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    fireEvent.click(screen.getByRole("button", { name: "Continue without live progress" }));
    await screen.findByRole("heading", { name: /^Hand over to/ });
  });

  it("calls an install that cannot run a failure, and offers to retry", async () => {
    stub(broken());
    open();
    await screen.findByText("Could not set up Live Observation");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it("says installed-but-quiet without dressing it as success", async () => {
    stub(untested());
    open();
    await screen.findByText("Installed, but nothing has come through yet");
    expect(screen.getByText("Untested")).toBeTruthy();
    expect(document.querySelector(".state-panel.tone-unsure")).toBeTruthy();
    expect(document.querySelector(".state-panel.tone-ok")).toBeNull();
  });

  it("keeps paths and hook entries out of the main flow", async () => {
    stub();
    open();
    await screen.findByRole("heading", { name: "Enable Live Observation" });
    expect(screen.queryByText(/settings\.json/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Technical details/ }));
    expect(screen.getByText("/tmp/home/.claude/settings.json")).toBeTruthy();
  });
});

/**
 * After the copy. The modal stays open, because closing would read as "handed
 * over, done" while the session has not started — and nothing here may report
 * a live session merely because a prompt reached the clipboard.
 */
describe("waiting for the session", () => {
  const snapshot = (state: string, runId: string) => ({
    runs: [{ anthillRunId: runId, state }],
    capabilities: [],
  });

  async function copied(onClose = vi.fn()) {
    const stubbed = stub();
    open(withRoot(CHOSEN), vi.fn(), onClose);
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(stubbed.copied).toHaveLength(1));
    return { ...stubbed, onClose };
  }

  it("stays open on a successful copy", async () => {
    const { onClose } = await copied();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says it is waiting, and that copying started nothing", async () => {
    await copied();
    expect(screen.getByText(/Waiting for the session in Claude Code/)).toBeTruthy();
    expect(screen.getByText(/Copying does not start anything/)).toBeTruthy();
  });

  it("closes when a session carrying this run's marker turns up", async () => {
    const { listeners, requests, onClose } = await copied();
    const runId = (requests[0] as { anthillRunId: string }).anthillRunId;
    act(() => listeners.forEach((push) => push(snapshot("detected_live", runId))));
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores a session that is not this run", async () => {
    const { listeners, onClose } = await copied();
    act(() => listeners.forEach((push) => push(snapshot("detected_live", "ANT-SOMEBODY-ELSE"))));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("will not pick one of several and call it yours", async () => {
    const { listeners, requests, onClose } = await copied();
    const runId = (requests[0] as { anthillRunId: string }).anthillRunId;
    act(() => listeners.forEach((push) => push(snapshot("ambiguous_match", runId))));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("More than one session could be this workflow")).toBeTruthy();
    expect(screen.getByText(/will not pick one and claim it is yours/)).toBeTruthy();
  });

  it("does not wait for an event that cannot arrive", async () => {
    // Observation unavailable: the copy still works and the flow ends there.
    const stubbed = stub(harness({ cliAvailable: false, hookEntriesPresent: false, hookInstalled: false }));
    open();
    await toHandover();
    fireEvent.click(copyButton());
    await waitFor(() => expect(stubbed.copied).toHaveLength(1));
    expect(screen.queryByText(/Waiting for the session/)).toBeNull();
  });
});

