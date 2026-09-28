/**
 * The Workflow's shape after the v4 hierarchy.
 *
 * These are mostly assertions about what is *not* there any more: a tab group
 * that a canvas click could navigate away from, four sub-tabs inside it, and a
 * Brief surface. What replaces them has to be reachable without any of that.
 */

import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingRun } from "@anthill/live";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

import type { SaveWorkflowResult } from "../../shared/ipc.js";
import { WorkflowScreen } from "./WorkflowScreen.js";

type Snapshot = { runs: PendingRun[]; capabilities: unknown[] };
type SnapshotListener = (snapshot: Snapshot) => void;

/** The id of the workflow the Prompt modal last registered observation for. */
let observedWorkflowId: string | undefined;

/** The File ▸ Save listener the screen registered, if it is mounted. */
let menuSave: (() => void) | undefined;

function stubApi() {
  observedWorkflowId = undefined;
  menuSave = undefined;
  const api = {
    contract: 2,
    capabilities: vi.fn(
      async (): Promise<{ contract: number; channels: string[] }> => ({
        contract: 2,
        channels: [],
      }),
    ),
    listRecentPlans: vi.fn(async () => []),
    setWorkflowDirty: vi.fn(async () => undefined),
    liveSnapshot: vi.fn(async (): Promise<Snapshot> => ({ runs: [], capabilities: [] })),
    // The live page draws a run from the snapshot its record kept rather than
    // from the open canvas. These tests open a run the store knows nothing
    // about, which is the case that falls back to what is on screen.
    getRun: vi.fn(async () => undefined),
    liveObserve: vi.fn(async (input: { workflowId?: string }): Promise<Snapshot> => {
      observedWorkflowId = input.workflowId;
      return { runs: [], capabilities: [] };
    }),
    copyPrompt: vi.fn(async () => true),
    onLiveSnapshot: vi.fn((_listener: SnapshotListener): (() => void) => () => undefined),
    liveEvents: vi.fn(async (): Promise<unknown[]> => []),
    onLiveEvents: vi.fn((): (() => void) => () => undefined),
    liveSetupStatus: vi.fn(async () => ({ dismissed: true, trigger: "", harnesses: [] })),
    // The agents rail offers the global library alongside the workflow's own.
    agentsList: vi.fn(async () => []),
    detectInterpreters: vi.fn(async () => []),
    exportWorkflow: vi.fn(async () => ({ ok: true as const, directory: "/tmp", written: [] })),
    chooseRunFolder: vi.fn(async (): Promise<string | null> => "/tmp"),
    saveWorkflow: vi.fn(async (): Promise<SaveWorkflowResult> => ({ kind: "saved", path: "/tmp/w.workflow.json" })),
    openWorkflow: vi.fn(async () => ({ ok: false as const, cancelled: true as const })),
    // Which workflow is open is what main answers an `anthill://` link with,
    // so the screen tells it on every open and on unmount.
    workflowOpened: vi.fn(async () => undefined),
    // File ▸ Save / ⌘S arrives from the menu, so tests hold the listener and
    // fire it themselves rather than pressing a key the page never sees.
    onSaveWorkflow: vi.fn((listener: () => void): (() => void) => {
      menuSave = listener;
      return () => {
        menuSave = undefined;
      };
    }),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

/**
 * Open the workflow on a template with steps, agents and a loop.
 *
 * Rendered in StrictMode, as the app is. Without it a state updater that sets
 * other state — a render-phase update — behaves in tests and misbehaves in the
 * app, which is exactly what happened to Step back: the buttons moved and the
 * canvas did not, and the test passed the whole time.
 */
async function workflow() {
  stubApi();
  render(
    <StrictMode>
      <WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />
    </StrictMode>,
  );
  const template = await screen.findByText(/Implement, test, fix/);
  fireEvent.click(template.closest("button") as HTMLElement);
  await screen.findByRole("button", { name: "Prompt" });
}

beforeEach(() => {
  // jsdom has neither, and the canvas reaches for both.
  Element.prototype.scrollIntoView = vi.fn();
  if (!("PointerEvent" in window)) {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
});

// The stub outlives each test on purpose: Testing Library unmounts after the
// test body, and the screen's unmount cleanup still talks to the bridge.
afterEach(() => {
  vi.clearAllMocks();
});

describe("the Workflow hierarchy", () => {
  it("has no right-sidebar tab group at all", async () => {
    await workflow();
    expect(document.querySelector(".tabs")).toBeNull();
    for (const gone of ["Block", "Connection", "Brief", "Problems"]) {
      expect(
        [...document.querySelectorAll(".inspector button")].some(
          (button) => button.textContent === gone,
        ),
      ).toBe(false);
    }
  });

  it("has no Brief surface anywhere", async () => {
    await workflow();
    expect(screen.queryByText("Brief")).toBeNull();
    expect(screen.queryByRole("button", { name: /brief/i })).toBeNull();
    expect(document.body.textContent).not.toContain("Open the brief");
  });

  it("names what the inspector is showing instead of offering tabs", async () => {
    await workflow();
    const header = document.querySelector(".inspector-top h2");
    expect(header?.textContent).toBe("Inspector");
  });

  it("shows a compact empty state with the workflow's counts", async () => {
    await workflow();
    const idle = document.querySelector(".inspector-idle") as HTMLElement;
    expect(within(idle).getByText("Nothing selected")).toBeTruthy();
    expect(within(idle).getByText(/blocks$/)).toBeTruthy();
    expect(within(idle).getByText(/agents$/)).toBeTruthy();
  });
});

describe("agents as a library", () => {
  it("keeps agents reachable from the left rail, not a contextual tab", async () => {
    await workflow();
    const rail = document.querySelector(".libraries") as HTMLElement;
    const agentsTab = within(rail).getByRole("tab", { name: /Agents/ });
    fireEvent.click(agentsTab);
    expect(document.querySelector(".agent-rail")).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "+ New agent" })).toBeTruthy();
  });

  it("opens an agent in the one inspector when its row is picked", async () => {
    await workflow();
    fireEvent.click(within(document.querySelector(".libraries") as HTMLElement)
      .getByRole("tab", { name: /Agents/ }));
    const rows = document.querySelectorAll(".agent-rail .rail-agent");
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);

    await waitFor(() =>
      expect(document.querySelector(".inspector-top h2")?.textContent).toBe("Agent profile"),
    );
    expect(document.querySelector(".agent-editor")).toBeTruthy();
  });

  it("does not borrow the light-surface row styles for a dark rail", async () => {
    await workflow();
    fireEvent.click(within(document.querySelector(".libraries") as HTMLElement)
      .getByRole("tab", { name: /Agents/ }));

    // `DraftClarify` draws agent rows with `.agent-row` on light paper. Sharing
    // that class once left this list with near-black text on a dark panel, so
    // the rail owns its own names.
    expect(document.querySelectorAll(".agent-rail .agent-row")).toHaveLength(0);
    const rows = document.querySelectorAll(".rail-agent");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].querySelector(".rail-agent-name")).toBeTruthy();
    expect(rows[0].querySelector(".rail-agent-steps")).toBeTruthy();
  });

  it("reads role and model on one line, with the step count beside it", async () => {
    await workflow();
    fireEvent.click(within(document.querySelector(".libraries") as HTMLElement)
      .getByRole("tab", { name: /Agents/ }));

    const row = document.querySelector(".rail-agent") as HTMLElement;
    expect(within(row).getByText("Developer")).toBeTruthy();
    expect(row.querySelector(".rail-agent-sub")?.textContent).toContain("sonnet");
    expect(row.querySelector(".rail-agent-steps")?.textContent).toBe("2 steps");
  });

  it("survives a canvas selection – the library does not navigate away", async () => {
    await workflow();
    const rail = document.querySelector(".libraries") as HTMLElement;
    fireEvent.click(within(rail).getByRole("tab", { name: /Agents/ }));

    const block = within(document.querySelector(".canvas-area") as HTMLElement)
      .getAllByText("Implement")[0]
      .closest("[data-testid], div") as HTMLElement;
    fireEvent.click(block);

    // The inspector may now show the block, but the agents are still listed.
    expect(document.querySelector(".agent-rail")).toBeTruthy();
  });
});


describe("the live session page and what main knows", () => {
  /**
   * The page used to be handed a copy of the run when it opened and never a
   * newer one. A session that finished went on being drawn as live for as long
   * as the page stayed open — including its final step, which only settles once
   * the run itself has.
   */
  const observed: PendingRun = {
    anthillRunId: "ANT-11112222",
    correlationNonce: "aa11bb",
    selectedCli: "codex" as const,
    promptVersion: "1",
    bootstrapPromptHash: "hash",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    state: "detected_live" as const,
    detectedSessionId: "sess-1",
    confidence: "strong" as const,
    evidenceChannel: "codex:rollout",
    lastObservedAt: new Date().toISOString(),
  };

  it("follows the run's state after the page is open", async () => {
    const api = stubApi();
    api.liveSnapshot.mockResolvedValue({ runs: [observed], capabilities: [] });
    api.capabilities.mockResolvedValue({
      contract: 2,
      channels: ["live:events", "live:onEvents"],
    });

    const listeners: SnapshotListener[] = [];
    api.onLiveSnapshot.mockImplementation((listener: SnapshotListener) => {
      listeners.push(listener);
      return () => undefined;
    });

    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    await openTemplateAndLearnId();
    for (const listener of listeners) {
      listener({ runs: [{ ...observed, workflowId: observedWorkflowId }], capabilities: [] });
    }

    // Targeted by class, not by a name regex: "Live setup" sits in the same
    // topbar and a loose matcher picks it up instead.
    const chip = await waitFor(() => {
      const found = document.querySelector("button.presence-chip");
      if (!found) throw new Error("no presence chip yet");
      return found as HTMLElement;
    });
    fireEvent.click(chip);
    await screen.findByText("Anthill is observing, not running");

    // Main now says the session finished. The page has to say so too.
    for (const listener of listeners) {
      listener({ runs: [{ ...observed, state: "completed" }], capabilities: [] });
    }

    await waitFor(() => {
      expect(
        (document.querySelector(".presence-label") as HTMLElement).textContent,
      ).toContain("Session finished");
    });
  });

  /*
   * ANT-157. The session was announced while live and finished before the
   * author clicked. The dialog handed the page its announced copy, no further
   * snapshot came, and the page said Live over a finished run for good.
   */
  it("opens the announced session as it is now, not as it was announced", async () => {
    const api = stubApi();
    const listeners: SnapshotListener[] = [];
    api.onLiveSnapshot.mockImplementation((listener: SnapshotListener) => {
      listeners.push(listener);
      return () => undefined;
    });

    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    await openTemplateAndLearnId();
    const live = { ...observed, anthillRunId: "ANT-157157AA", workflowId: observedWorkflowId };
    for (const listener of listeners) listener({ runs: [live], capabilities: [] });
    await screen.findByRole("button", { name: "Open the live session" });

    // It finishes while the dialog is still up; nothing arrives afterwards.
    for (const listener of listeners) {
      listener({ runs: [{ ...live, state: "completed" }], capabilities: [] });
    }
    fireEvent.click(await screen.findByRole("button", { name: "Open the session report" }));

    await waitFor(() => {
      expect((document.querySelector(".presence-label") as HTMLElement).textContent).toContain("Session finished");
    });
    expect(screen.queryByRole("button", { name: /Stop observing/ })).toBeNull();
  });

  it("does not let a late first snapshot undo a newer push", async () => {
    const api = stubApi();
    let answer: (snapshot: Snapshot) => void = () => undefined;
    api.liveSnapshot.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const listeners: SnapshotListener[] = [];
    api.onLiveSnapshot.mockImplementation((listener: SnapshotListener) => {
      listeners.push(listener);
      return () => undefined;
    });

    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    await openTemplateAndLearnId();
    const live = { ...observed, anthillRunId: "ANT-157157BB", workflowId: observedWorkflowId };
    for (const listener of listeners) {
      listener({ runs: [{ ...live, state: "completed" }], capabilities: [] });
    }
    await waitFor(() => {
      expect((document.querySelector(".presence-label") as HTMLElement).textContent).toContain("Session finished");
    });

    // The answer to the first ask, made before the push, lands only now.
    await act(async () => answer({ runs: [live], capabilities: [] }));

    expect((document.querySelector(".presence-label") as HTMLElement).textContent).toContain("Session finished");
    expect(screen.queryByRole("button", { name: "Open the live session" })).toBeNull();
  });

  /**
   * A template instance has its own id now, so a test cannot name it up front.
   * It is learned the way the product learns it: from the call the Prompt modal
   * makes when the author copies the prompt.
   */
  async function openTemplateAndLearnId() {
    const template = await screen.findByText(/One agent solves it/);
    fireEvent.click(template.closest("button") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Prompt" }));
    // The handover opens on its folder step, which this test has no interest
    // in: it only needs the copy, which is what registers the run.
    fireEvent.click(await screen.findByRole("button", { name: "Copy without agent files" }));
    await waitFor(() => expect(observedWorkflowId).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
  }

  it("says nothing about a run belonging to a different workflow", async () => {
    // The bug: a workflow created seconds earlier showed "Session finished"
    // for somebody else's run, under a plaque claiming nothing had been
    // written back into "this workflow" — one it had never touched.
    const api = stubApi();
    api.liveSnapshot.mockResolvedValue({
      runs: [{ ...observed, workflowId: "some-other-workflow", state: "completed" }],
      capabilities: [],
    });

    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/One agent solves it/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    await waitFor(() => expect(api.liveSnapshot).toHaveBeenCalled());
    expect(document.querySelector(".presence-chip")).toBeNull();
    expect(document.querySelector(".presence-plaque")).toBeNull();
  });

  it("keeps the last it knew when the run leaves the snapshot", async () => {
    const api = stubApi();
    api.liveSnapshot.mockResolvedValue({ runs: [observed], capabilities: [] });
    const listeners: SnapshotListener[] = [];
    api.onLiveSnapshot.mockImplementation((listener: SnapshotListener) => {
      listeners.push(listener);
      return () => undefined;
    });

    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    await openTemplateAndLearnId();
    for (const listener of listeners) {
      listener({ runs: [{ ...observed, workflowId: observedWorkflowId }], capabilities: [] });
    }
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector("button.presence-chip");
        if (!found) throw new Error("no presence chip yet");
        return found as HTMLElement;
      }),
    );
    await screen.findByText("Anthill is observing, not running");

    for (const listener of listeners) listener({ runs: [], capabilities: [] });

    await waitFor(() => {
      expect(screen.getByText("ANT-11112222")).toBeTruthy();
    });
  });
});

/**
 * Describe a change, as the diagram's own tool.
 *
 * ANT-37. It moved out of the topbar because it edits the diagram, not the
 * document — the topbar's other buttons (New, Open, Save, Prompt) act on the
 * file. And while it is open a canvas click has nothing to select into, so it
 * references the block instead.
 */
describe("the describe-a-change assistant", () => {
  const toggle = () => screen.getByRole("button", { name: /Describe a change|Edit manually/ });

  it("is not in the topbar", async () => {
    await workflow();
    const topbar = document.querySelector(".topbar") ?? document.body;
    expect(
      [...topbar.querySelectorAll("button")].some((b) => b.textContent === "Describe a change"),
    ).toBe(false);
  });

  it("opens from the canvas and replaces the inspector", async () => {
    await workflow();
    expect(document.querySelector(".inspector-top h2")?.textContent).toBe("Inspector");

    fireEvent.click(toggle());

    expect(document.querySelector(".assistant-top h2")?.textContent).toBe("Assistant");
    // Outright, not beside it: there is no inspector left underneath.
    expect(document.querySelector(".inspector-top")).toBeNull();
  });

  it("is a toggle, and the sidebar ✕ is the same toggle", async () => {
    await workflow();
    fireEvent.click(toggle());
    expect(toggle().textContent).toContain("Edit manually");

    fireEvent.click(screen.getByRole("button", { name: "Close the assistant" }));
    expect(document.querySelector(".assistant-top")).toBeNull();
    expect(document.querySelector(".inspector-top h2")?.textContent).toBe("Inspector");
  });

  it("references a block on click instead of selecting it", async () => {
    await workflow();
    fireEvent.click(toggle());

    const block = document.querySelector('[data-testid^="workflow-block-"]') as HTMLElement;
    fireEvent.click(block);

    // A mention appeared, and the inspector did not come back to show a block.
    expect(document.querySelector(".assistant-mentions")).toBeTruthy();
    expect(document.querySelector(".inspector-top")).toBeNull();
  });

  it("clicking the same block again drops the reference", async () => {
    await workflow();
    fireEvent.click(toggle());
    const block = document.querySelector('[data-testid^="workflow-block-"]') as HTMLElement;

    fireEvent.click(block);
    expect(document.querySelectorAll(".assistant-mentions .mention-pill")).toHaveLength(1);
    fireEvent.click(block);
    expect(document.querySelector(".assistant-mentions")).toBeNull();
  });

  it("gives the canvas back its ordinary click when closed", async () => {
    await workflow();
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    const block = document.querySelector('[data-testid^="workflow-block-"]') as HTMLElement;
    fireEvent.click(block);
    // Selection works again, so the inspector is naming the block it holds.
    expect(document.querySelector(".inspector-top h2")?.textContent).toBe("Selected block");
    expect(document.querySelector(".inspector-idle")).toBeNull();
  });

  it("forgets the references when it closes", async () => {
    await workflow();
    fireEvent.click(toggle());
    fireEvent.click(document.querySelector('[data-testid^="workflow-block-"]') as HTMLElement);
    expect(document.querySelectorAll(".mention-pill")).toHaveLength(1);

    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(document.querySelector(".assistant-mentions")).toBeNull();
  });
});

/**
 * Stepping the workflow back and forward.
 *
 * ANT-38. Every change goes through one funnel, so one history covers the
 * canvas, the inspector, the agent library and the assistant at once.
 */
describe("stepping through edits", () => {
  const back = () => screen.getByRole("button", { name: "Step back" }) as HTMLButtonElement;
  const forward = () => screen.getByRole("button", { name: "Step forward" }) as HTMLButtonElement;
  /*
    Unavailable is `aria-disabled`, not `disabled` (ANT-85).

    A disabled button is removed from the tab order, so a keyboard user cannot
    reach it and cannot read the title that says why it does nothing. Dimmed
    and still reachable teaches; gone teaches nothing.
  */
  const unavailable = (button: HTMLButtonElement) =>
    button.getAttribute("aria-disabled") === "true";

  it("offers nowhere to go on a freshly opened workflow", async () => {
    await workflow();
    expect(unavailable(back())).toBe(true);
    expect(unavailable(forward())).toBe(true);
    // Reachable, so the title can explain itself.
    expect(back().disabled).toBe(false);
    expect(back().title).toBe("Nothing to undo");
    expect(forward().title).toBe("Nothing to redo");
  });

  it("takes an edit back and puts it forward again", async () => {
    await workflow();
    const name = screen.getByDisplayValue(/Implement, test, fix/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed workflow" } });

    expect(unavailable(back())).toBe(false);
    fireEvent.click(back());
    expect((screen.getByDisplayValue(/Implement, test, fix/) as HTMLInputElement).value).toContain(
      "Implement, test, fix",
    );

    expect(unavailable(forward())).toBe(false);
    fireEvent.click(forward());
    expect(screen.getByDisplayValue("Renamed workflow")).toBeTruthy();
  });

  it("abandons the forward branch once a new edit lands", async () => {
    await workflow();
    const name = () =>
      document.querySelector(
        ".topbar input[type='text'], .topbar input:not([type])",
      ) as HTMLInputElement;
    fireEvent.change(name(), { target: { value: "First" } });
    fireEvent.click(back());
    expect(unavailable(forward())).toBe(false);

    fireEvent.change(name(), { target: { value: "Second" } });
    expect(unavailable(forward())).toBe(true);
  });

  it("covers an edit made from the assistant, not only the canvas", async () => {
    // One funnel, one history: the point of recording at editWorkflow.
    await workflow();
    fireEvent.change(screen.getByDisplayValue(/Implement, test, fix/), {
      target: { value: "Edited" },
    });
    expect(unavailable(back())).toBe(false);
  });
});

/**
 * The Prompt button's gate.
 *
 * The gate is behaviour, not styling. A control that presents itself as
 * unavailable must not perform the action — that pairing broke once during
 * this work, which is why it is a test and not a comment.
 */
describe("the gate on the handover", () => {
  /** Empty the open agent's fields, which is one way to earn an error. */
  function breakTheWorkflow() {
    fireEvent.click(within(document.querySelector(".libraries") as HTMLElement)
      .getByRole("tab", { name: /Agents/ }));
    fireEvent.click(document.querySelectorAll(".agent-rail .rail-agent")[0]);
    const editor = document.querySelector(".agent-editor") as HTMLElement;
    for (const field of editor.querySelectorAll("input, textarea")) {
      fireEvent.change(field, { target: { value: "" } });
    }
  }

  const prompt = () => screen.getByRole("button", { name: /Prompt/ });

  it("opens the handover when there is nothing to fix", async () => {
    await workflow();
    fireEvent.click(prompt());
    expect(screen.getByRole("dialog", { name: /Hand over the prompt/ })).toBeTruthy();
  });

  it("never opens it while the workflow has errors", async () => {
    await workflow();
    breakTheWorkflow();

    expect(prompt().className).toContain("is-blocked");
    expect(prompt().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(prompt());
    expect(screen.queryByRole("dialog", { name: /Hand over the prompt/ })).toBeNull();
  });

  it("sends the author to the problems that blocked it", async () => {
    // A button that cannot be clicked cannot say where to go instead, so this
    // one is blocked rather than disabled.
    await workflow();
    breakTheWorkflow();
    fireEvent.click(prompt());
    expect(document.querySelector(".problems-popover")).toBeTruthy();
  });
});

/**
 * Pressing Save used to produce nothing anybody could see.
 *
 * The write happened and the dirty pill went out; on a workflow that was
 * already saved even that did not move, so the click had no visible effect at
 * all and "did that work?" had no answer on the screen (ANT-58).
 */
describe("what Save says for itself", () => {
  /** The toolbar's own Save, not the handover's. */
  const saveButton = () => screen.getByRole("button", { name: "Save" });
  const status = () => document.querySelector(".save-status")?.textContent ?? "";

  it("says nothing before anything has been saved", async () => {
    await workflow();
    expect(status()).toBe("");
  });

  it("confirms a write once it has actually landed", async () => {
    await workflow();
    fireEvent.click(saveButton());
    await screen.findByText("Saved");
  });

  it("holds off saying so until the write comes back", async () => {
    const api = stubApi();
    let land: (result: SaveWorkflowResult) => void = () => undefined;
    api.saveWorkflow = vi.fn(
      () => new Promise<SaveWorkflowResult>((resolve) => { land = resolve; }),
    );
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    fireEvent.click(saveButton());
    await screen.findByText("Saving…");
    expect(screen.queryByText("Saved")).toBeNull();

    await act(async () => {
      land({ kind: "saved", path: "/tmp/w.workflow.json" });
    });
    await screen.findByText("Saved");
  });

  it("claims nothing when the author cancels the dialog", async () => {
    const api = stubApi();
    api.saveWorkflow = vi.fn(async (): Promise<SaveWorkflowResult> => ({ kind: "cancelled" }));
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    fireEvent.click(saveButton());
    await waitFor(() => expect(status()).toBe(""));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("gives the reason when the write is refused, and keeps the work", async () => {
    const api = stubApi();
    api.saveWorkflow = vi.fn(
      async (): Promise<SaveWorkflowResult> => ({ kind: "failed", error: "no space left on device" }),
    );
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    fireEvent.click(saveButton());
    await screen.findByText(/no space left on device/);
    // Still theirs to save: nothing was written, so nothing may claim it was.
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("does not race a second click against the write already running", async () => {
    const api = stubApi();
    let land: (result: SaveWorkflowResult) => void = () => undefined;
    const calls = vi.fn(
      () => new Promise<SaveWorkflowResult>((resolve) => { land = resolve; }),
    );
    api.saveWorkflow = calls;
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    expect(calls).toHaveBeenCalledTimes(1);

    await act(async () => {
      land({ kind: "saved", path: "/tmp/w.workflow.json" });
    });
    await screen.findByText("Saved");
  });

  it("announces politely instead of taking the focus", async () => {
    await workflow();
    fireEvent.click(saveButton());
    await screen.findByText("Saved");
    const live = document.querySelector(".save-status") as HTMLElement;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("tabindex")).toBeNull();
    expect(document.activeElement).not.toBe(live);
  });
});

/**
 * ⌘S, which is the File menu's Save and not a second one.
 *
 * Binding it in the page as well would give one press two saves racing the
 * same file, and would have to carve out an exception for every text field
 * (ANT-59). The menu owns the key; this screen only answers it.
 */
describe("saving from the keyboard", () => {
  const status = () => document.querySelector(".save-status")?.textContent ?? "";

  it("saves the open workflow when the menu asks", async () => {
    await workflow();
    const api = (window as unknown as { anthill: { saveWorkflow: ReturnType<typeof vi.fn> } })
      .anthill;
    expect(menuSave).toBeTypeOf("function");

    await act(async () => {
      menuSave?.();
    });
    expect(api.saveWorkflow).toHaveBeenCalledTimes(1);
    await screen.findByText("Saved");
  });

  it("reports through the same indicator the toolbar uses", async () => {
    const api = stubApi();
    api.saveWorkflow = vi.fn(
      async (): Promise<SaveWorkflowResult> => ({ kind: "failed", error: "read-only volume" }),
    );
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    await act(async () => {
      menuSave?.();
    });
    await waitFor(() => expect(status()).toContain("read-only volume"));
  });

  it("saves what is on screen now, not what was there when it opened", async () => {
    await workflow();
    const api = (window as unknown as {
      anthill: { saveWorkflow: ReturnType<typeof vi.fn> };
    }).anthill;

    // Rename through the toolbar's own field, exactly as a person would.
    const name = document.querySelector(".topbar input") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed while open" } });

    await act(async () => {
      menuSave?.();
    });
    const [request] = api.saveWorkflow.mock.calls.at(-1) as [{ workflow: { name: string } }];
    expect(request.workflow.name).toBe("Renamed while open");
  });

  it("does not start a second save over one already running", async () => {
    const api = stubApi();
    let land: (result: SaveWorkflowResult) => void = () => undefined;
    api.saveWorkflow = vi.fn(
      () => new Promise<SaveWorkflowResult>((resolve) => { land = resolve; }),
    );
    render(<WorkflowScreen onExit={() => undefined} onSettings={() => undefined} />);
    const template = await screen.findByText(/Implement, test, fix/);
    fireEvent.click(template.closest("button") as HTMLElement);
    await screen.findByRole("button", { name: "Prompt" });

    await act(async () => {
      menuSave?.();
      menuSave?.();
    });
    expect(api.saveWorkflow).toHaveBeenCalledTimes(1);
    await act(async () => {
      land({ kind: "saved", path: "/tmp/w.workflow.json" });
    });
  });
});

/**
 * A handed-over workflow is saved on purpose, and not before (ANT-116).
 *
 * ANT-92 removed the approval gate and put autosave in its place, which left
 * the user with nothing to press and a badge to interpret instead. `Save` is
 * the act again — and it is the one thing standing between a broken graph and
 * a session being handed it, because a handover has no other way to record a
 * revision.
 */
describe("a handover being saved", () => {
  const HANDOVER: Workflow = {
    id: "workflow-1",
    name: "Handed over",
    version: "1",
    target: "claude-code",
    brief: { goal: "Fix the crash", doneCriteria: ["Tests pass"] },
    nodes: [
      { id: "start", name: "Start", type: "start", config: {} },
      { id: "end", name: "End", type: "end", config: {} },
    ],
    edges: [{ id: "a", source: "start", target: "end" }],
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [] } },
  };

  const PATH = "/data/exchange/workflows/workflow-1/workflow.json";

  function openHandover() {
    const api = stubApi();
    Object.assign(api, {
      openWorkflow: vi.fn(async () => ({
        ok: true as const,
        opened: { workflow: HANDOVER, path: PATH },
      })),
      exchangeRead: vi.fn(async () => ({
        workflowId: "workflow-1",
        revision: 1,
        digest: "sha256:abc",
        state: "ready_for_agent" as const,
        mode: "design" as const,
        source: { harness: "claude-code" as const, sessionId: "s1", taskText: "Fix the crash" },
        problems: [],
        bindings: [],
      })),
    });
    render(
      <WorkflowScreen
        onExit={() => undefined}
        onSettings={() => undefined}
        start={{ kind: "open", path: PATH }}
      />,
    );
    return api as unknown as { saveWorkflow: ReturnType<typeof vi.fn> };
  }

  async function rename(to: string) {
    const name = await waitFor(() => {
      const found = document.querySelector(".topbar input") as HTMLInputElement | null;
      if (!found) throw new Error("no name field yet");
      return found;
    });
    fireEvent.change(name, { target: { value: to } });
  }

  it("writes nothing on a keystroke, and nothing when the window loses focus", async () => {
    const api = openHandover();
    await rename("Renamed by the reader");

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    // Well past the pause the old autosave waited out.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(api.saveWorkflow).not.toHaveBeenCalled();
  });

  it("writes what is on screen when Save is pressed", async () => {
    const api = openHandover();
    await rename("Renamed by the reader");

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.saveWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          path: PATH,
          workflow: expect.objectContaining({ name: "Renamed by the reader" }),
        }),
      ),
    );
  });
});

/**
 * A handover the user asked to watch rather than to edit (ANT-118).
 *
 * `/anthill:workflow watch` is the user saying they want to see the work
 * happen, not compose it: the harness wrote the graph itself and is already
 * doing the job. There is nothing on the canvas for them to settle, so the
 * canvas is not where they should be left — and finding the presence chip and
 * clicking it is exactly the step the command exists to remove.
 *
 * The switch cannot happen when the workflow arrives, because nothing has
 * bound it yet and a Live Session page with no run is a page about nothing. So
 * these pin the moment it can happen: as soon as a run for this workflow is
 * observed.
 */
describe("a handover the user asked to watch", () => {
  const WATCHED: Workflow = {
    id: "workflow-2",
    name: "Watched",
    version: "1",
    target: "claude-code",
    brief: { goal: "Fix the crash", doneCriteria: ["Tests pass"] },
    nodes: [
      { id: "start", name: "Start", type: "start", config: {} },
      { id: "end", name: "End", type: "end", config: {} },
    ],
    edges: [{ id: "a", source: "start", target: "end" }],
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [] } },
  };

  const PATH = "/data/exchange/workflows/workflow-2/workflow.json";

  const run: PendingRun = {
    anthillRunId: "ANT-22223333",
    correlationNonce: "bb22cc",
    workflowId: "workflow-2",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "hash",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    state: "detected_live",
    detectedSessionId: "sess-2",
    confidence: "strong",
    evidenceChannel: "claude-code:transcript",
    lastObservedAt: new Date().toISOString(),
  };

  function open(mode: "watch" | "design", runs: PendingRun[]) {
    const api = stubApi();
    Object.assign(api, {
      openWorkflow: vi.fn(async () => ({
        ok: true as const,
        opened: { workflow: WATCHED, path: PATH },
      })),
      exchangeRead: vi.fn(async () => ({
        workflowId: "workflow-2",
        revision: 1,
        digest: "sha256:abc",
        state: "bound" as const,
        mode,
        source: { harness: "claude-code" as const, sessionId: "s2", taskText: "Fix the crash" },
        problems: [],
        bindings: [{ runId: run.anthillRunId, revision: 1 }],
      })),
    });
    api.liveSnapshot.mockResolvedValue({ runs, capabilities: [] });
    render(
      <WorkflowScreen
        onExit={() => undefined}
        onSettings={() => undefined}
        start={{ kind: "open", path: PATH }}
      />,
    );
    return api;
  }

  it("opens the live session without anybody clicking anything", async () => {
    open("watch", [run]);
    await screen.findByText("Anthill is observing, not running");
    // And not behind a dialog asking whether to go where they already are.
    expect(screen.queryByRole("button", { name: /Open session/i })).toBeNull();
  });

  it("stays on the canvas for a handover the user is meant to read", async () => {
    open("design", [run]);
    // The same run, the same graph: the mode is the only difference.
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByText("Anthill is observing, not running")).toBeNull();
  });

  it("lets the reader leave the session and stay left", async () => {
    open("watch", [run]);
    await screen.findByText("Anthill is observing, not running");
    fireEvent.click(await screen.findByTitle("Back to the workflow"));

    await screen.findByRole("button", { name: "Save" });
    // A second of the snapshot poll's worth of chances to drag them back.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByText("Anthill is observing, not running")).toBeNull();
  });
});

/**
 * Going to a problem, in whichever mode the author is in (ANT-114).
 *
 * The assistant replaces the inspector rather than sitting beside it, so while
 * it is open a selection has nowhere to be shown. Clicking a problem set the
 * selection anyway: the popover closed and nothing else happened.
 */
describe("clicking a problem", () => {
  /** An agent step with no agent assigned — two problems, one block. */
  const BROKEN: Workflow = {
    id: "workflow-broken",
    name: "Has a problem",
    version: "1",
    target: "claude-code",
    brief: { goal: "Fix the crash", doneCriteria: ["Tests pass"] },
    nodes: [
      { id: "start", name: "Start", type: "start", config: {} },
      { id: "step-1", name: "Do the work", type: "agent", config: {} },
      { id: "end", name: "End", type: "end", config: {} },
    ],
    edges: [
      { id: "a", source: "start", target: "step-1" },
      { id: "b", source: "step-1", target: "end" },
    ],
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [] } },
  };

  function openBroken() {
    const api = stubApi();
    Object.assign(api, {
      openWorkflow: vi.fn(async () => ({
        ok: true as const,
        opened: { workflow: BROKEN, path: "/tmp/broken.workflow.json" },
      })),
    });
    render(
      <WorkflowScreen
        onExit={() => undefined}
        onSettings={() => undefined}
        start={{ kind: "open", path: "/tmp/broken.workflow.json" }}
      />,
    );
    return api;
  }

  async function openProblems() {
    const pill = await waitFor(() => {
      const found = [...document.querySelectorAll(".topbar button")].find((button) =>
        /to fix$/.test(button.textContent ?? ""),
      );
      if (!found) throw new Error("no problems pill yet");
      return found as HTMLElement;
    });
    fireEvent.click(pill);
    return document.querySelectorAll(".problems-popover .problem");
  }

  it("mentions the block to the assistant while the assistant is open", async () => {
    openBroken();
    fireEvent.click(await screen.findByRole("button", { name: /Describe a change/ }));

    const rows = await openProblems();
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);

    // The mention is the assistant's own verb — the same thing a canvas click
    // does in this mode — and it is visible as a chip above the input.
    await waitFor(() => {
      const chips = document.querySelector(".assistant-mentions");
      expect(chips?.textContent).toContain("Do the work");
    });
  });

  it("selects the block when the assistant is closed", async () => {
    openBroken();

    const rows = await openProblems();
    fireEvent.click(rows[0]);

    // The inspector is what a selection is for, and it names the block.
    await waitFor(() => {
      const inspector = document.querySelector(".inspector");
      expect(inspector?.textContent).toContain("Do the work");
    });
  });
});

/*
  ANT-177 and ANT-180: the prompt's folder and the run it starts.
*/
describe("handing over the prompt", () => {
  const api = () => (window as unknown as { anthill: ReturnType<typeof stubApi> }).anthill;

  async function copyFromPrompt() {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    fireEvent.click(screen.getByRole("button", { name: /^Prompt$/ }));
    const dialog = await screen.findByRole("dialog", { name: /Hand over the prompt/ });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Choose folder…" })[0]);
    // Past the observation step, whatever it offers.
    const next = await within(dialog).findByRole("button", { name: /^(Continue|Continue with basic progress|Copy prompt)$/ });
    if (next.textContent !== "Copy prompt") fireEvent.click(next);
    const copy = await within(dialog).findByRole("button", { name: "Copy prompt" });
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(copy);
    await waitFor(() => expect(api().liveObserve).toHaveBeenCalled());
  }

  // ANT-177: a run from a workflow never saved had nowhere to be found.
  it("saves a workflow that was never saved as its prompt is copied, without asking", async () => {
    await workflow();
    await copyFromPrompt();
    await waitFor(() =>
      expect(api().saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ quiet: true })),
    );
  });

  // ANT-180: the run folder is not an edit the author made.
  it("keeps a saved, unchanged workflow saved when its run folder is chosen", async () => {
    await workflow();
    // Saved once, by hand.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api().saveWorkflow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api().setWorkflowDirty).toHaveBeenLastCalledWith(false));

    fireEvent.click(screen.getByRole("button", { name: /^Prompt$/ }));
    const dialog = await screen.findByRole("dialog", { name: /Hand over the prompt/ });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Choose folder…" })[0]);

    // Written into its file on the spot, to the path it was saved at.
    await waitFor(() => expect(api().saveWorkflow).toHaveBeenCalledTimes(2));
    const [request] = api().saveWorkflow.mock.calls.at(-1) as unknown as [{ path?: string; quiet?: boolean }];
    expect(request.path).toBe("/tmp/w.workflow.json");
    await waitFor(() => expect(api().setWorkflowDirty).toHaveBeenLastCalledWith(false));
  });
});
