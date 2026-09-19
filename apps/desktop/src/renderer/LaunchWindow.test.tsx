/**
 * The launch window after v5.
 *
 * The list stopped being a pile of files and became two questions: what is
 * happening, and what have I got. So most of these check that a state reaches
 * the row that has it — including the states that mean Anthill has *lost* the
 * session, which stay under Sessions because that is exactly what someone
 * needs to notice.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionState, PendingRun } from "@anthill/live";
import type { RecentWorkflow } from "../shared/ipc.js";

import { LaunchWindow } from "./LaunchWindow.js";

function workflow(partial: Partial<RecentWorkflow> & Pick<RecentWorkflow, "path" | "name">): RecentWorkflow {
  return {
    displayPath: `~/workflows/${partial.name}.json`,
    meta: "5 blocks · 2 agents · Claude Code",
    modifiedAt: "2026-08-29T09:00:00.000Z",
    ...partial,
  };
}

function run(state: LiveSessionState, workflowId: string, closed = false): PendingRun {
  return {
    anthillRunId: `ANT-${workflowId}`,
    correlationNonce: "aaaa11",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    workflowId,
    state,
    lastObservedAt: new Date(Date.now() - 5_000).toISOString(),
    ...(closed ? { closedAt: new Date(Date.now() - 60_000).toISOString() } : {}),
  };
}

function stub(recents: RecentWorkflow[], runs: PendingRun[] = [], events: unknown[] = []) {
  const api = {
    listRecentPlans: vi.fn(async () => recents),
    forgetRecentWorkflow: vi.fn(async () => undefined),
    liveSnapshot: vi.fn(async () => ({ runs, capabilities: [] })),
    onLiveSnapshot: vi.fn(() => () => undefined),
    liveEvents: vi.fn(async () => events),
    agentsList: vi.fn(async () => []),
    detectInterpreters: vi.fn(async () => []),
    codexModels: vi.fn(async () => undefined),
    piModels: vi.fn(async () => undefined),
    // Opening asks for a file from this screen, so the stub has to answer.
    openWorkflow: vi.fn(async () => ({ ok: false as const, cancelled: true as const })),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

async function show(recents: RecentWorkflow[], runs: PendingRun[] = [], events: unknown[] = []) {
  const api = stub(recents, runs, events);
  const onOpen = vi.fn();
  const onOpenLive = vi.fn();
  render(
    <LaunchWindow
      onNewWorkflow={() => undefined}
      onFromPrompt={() => undefined}
      onOpen={onOpen}
      onOpenLive={onOpenLive}
      onExplain={() => undefined}
      onSettings={() => undefined}
    />,
  );
  await waitFor(() => expect(api.listRecentPlans).toHaveBeenCalled());
  return { api, onOpen, onOpenLive };
}

/** A tab, found by its word rather than by its word plus its count. */
function tab(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the launch preference is gone", () => {
  it("offers no 'show this window' control and no Open button", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha" })]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/Show this window/)).toBeNull();
    // The row is the action now, so a button repeating it is one control too many.
    expect(screen.queryByRole("button", { name: /^Open Alpha/ })).toBeNull();
  });

  it("does not reach for an IPC method that no longer exists", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    expect("getShowOnLaunch" in api).toBe(false);
  });
});

describe("a row is the action", () => {
  it("selects on a single click and opens on a double", async () => {
    const { onOpen } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    const row = screen.getByText("Alpha").closest("button") as HTMLElement;

    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
    expect(row.className).toContain("is-selected");

    fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledWith("/a.json");
  });
});

describe("sessions and everything else", () => {
  it("groups a watched workflow apart from the rest", async () => {
    await show(
      [
        workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" }),
        workflow({ path: "/b.json", name: "Beta", workflowId: "workflow-b" }),
      ],
      [run("detected_live", "workflow-a")],
    );

    const groups = [...document.querySelectorAll(".launch-group-head")].map((n) =>
      (n.textContent ?? "").replace(/\d+$/, ""),
    );
    expect(groups).toEqual(["Sessions", "Recent workflows"]);
  });

  it("matches an observation to a workflow by id, not by name", async () => {
    await show(
      [
        workflow({ path: "/a.json", name: "Same name", workflowId: "workflow-a" }),
        workflow({ path: "/b.json", name: "Same name", workflowId: "workflow-b" }),
      ],
      [run("detected_live", "workflow-b")],
    );
    const sessions = document.querySelector(".launch-group") as HTMLElement;
    // The live chip must be on /b, and there is no way to tell from the name.
    expect(within(sessions).getAllByText("Same name")).toHaveLength(1);
    expect(within(sessions).getByText(/^Live/)).toBeTruthy();
  });

  it.each([
    ["detected_live", "Live"],
    ["pending_after_copy", "Waiting for a session"],
    ["ambiguous_match", "Ambiguous session"],
    ["observation_lost", "Observation lost"],
  ] as const)("keeps a %s workflow under Sessions, chipped %s", async (state, label) => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run(state, "workflow-a")]);
    const head = document.querySelector(".launch-group-head") as HTMLElement;
    expect(head.textContent).toContain("Sessions");
    expect(screen.getByText(new RegExp(`^${label}`))).toBeTruthy();
  });

  it("keeps a session Anthill is still watching under Sessions", async () => {
    // Quiet is not gone: the observers keep their place, and it comes back on
    // its own if the CLI writes again.
    await show(
      [workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })],
      [run("observation_lost", "workflow-a")],
    );
    expect((document.querySelector(".launch-group-head") as HTMLElement).textContent).toContain(
      "Sessions",
    );
  });

  it("drops a session Anthill has given up on into the workflow list", async () => {
    await show(
      [workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })],
      [run("observation_lost", "workflow-a", true)],
    );
    // No Sessions group at all, but the row still says what happened to it.
    expect(document.querySelectorAll(".launch-group-head")).toHaveLength(0);
    expect(screen.getByText("Observation lost")).toBeTruthy();
  });

  it("puts a failed run in the workflow list, since nothing is being watched", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run("failed", "workflow-a", true)]);
    expect(document.querySelectorAll(".launch-group-head")).toHaveLength(0);
    expect(screen.getByText("Session failed")).toBeTruthy();
  });

  it("puts a finished session back in the workflow list", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run("completed", "workflow-a")]);
    // Only one group, and it is not Sessions.
    expect(document.querySelectorAll(".launch-group-head")).toHaveLength(0);
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("names the step a live session last announced", async () => {
    await show(
      [workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a", steps: { n3: "Run tests" } })],
      [run("detected_live", "workflow-a")],
      [{ seq: 1, blockId: "n3", kind: "step.marker" }],
    );
    // "Live" alone says less than it could; the announced step is a fact.
    await waitFor(() => expect(screen.getByText("Live · Run tests")).toBeTruthy());
  });

  it("falls back to plain Live when nothing has been announced", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run("detected_live", "workflow-a")]);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("pulses only a confident match", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run("detected_live", "workflow-a")]);
    expect(document.querySelector(".recent-chip.is-pulsing")).toBeTruthy();
  });

  it("does not pulse a session it has lost", async () => {
    await show(
      [workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })],
      [run("observation_lost", "workflow-a")],
    );
    expect(document.querySelector(".recent-chip.is-pulsing")).toBeNull();
  });

  it("opens a live row onto its session, and any other row into the workflow", async () => {
    const { onOpen, onOpenLive } = await show(
      [
        workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" }),
        workflow({ path: "/b.json", name: "Beta", workflowId: "workflow-b" }),
      ],
      [run("detected_live", "workflow-a")],
    );

    fireEvent.doubleClick(screen.getByText("Alpha").closest("button") as HTMLElement);
    expect(onOpenLive).toHaveBeenCalledWith("/a.json", expect.objectContaining({ workflowId: "workflow-a" }));

    fireEvent.doubleClick(screen.getByText("Beta").closest("button") as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith("/b.json");
  });

  it("tells the time by the session, not the file, when there is one", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha", workflowId: "workflow-a" })], [run("pending_after_copy", "workflow-a")]);
    // "26 Aug" says nothing useful about a prompt copied two minutes ago.
    expect(screen.getByText(/copied \d+m ago/)).toBeTruthy();
  });
});

describe("taking a workflow off the list", () => {
  it("removes the selected row on Delete", async () => {
    const { api } = await show([
      workflow({ path: "/a.json", name: "Alpha" }),
      workflow({ path: "/b.json", name: "Beta" }),
    ]);

    fireEvent.click(screen.getByText("Beta").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(api.forgetRecentWorkflow).toHaveBeenCalledWith("/b.json"));
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("removes without announcing it", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(api.forgetRecentWorkflow).toHaveBeenCalledWith("/a.json"));
    // The row leaving is the whole message. A notice explaining a removal the
    // author just asked for reads as though something had gone wrong.
    expect(document.querySelector(".launch-note.is-said")).toBeNull();
  });

  it("takes the row off the list without touching the file", async () => {
    // Anthill did not create these files and does not delete them. The only
    // call this makes is the one that forgets the path.
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(api.forgetRecentWorkflow).toHaveBeenCalledWith("/a.json"));
    expect(api).not.toHaveProperty("deleteWorkflow");
    expect(Object.keys(api).some((name) => /delete|unlink|remove/i.test(name))).toBe(false);
  });

  it("says so when the removal itself failed, because the row comes back", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    api.forgetRecentWorkflow.mockRejectedValueOnce(new Error("nope"));
    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    expect(await screen.findByText(/could not be removed/)).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("takes Backspace too, since the key is named differently per keyboard", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(api.forgetRecentWorkflow).toHaveBeenCalled());
  });

  it("leaves Delete alone while the filter has focus", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);

    const field = screen.getByLabelText("Filter recent workflows");
    field.focus();
    // Bubbles to the window listener, which looks at what has focus.
    fireEvent.keyDown(field, { key: "Delete" });

    // Delete is how you fix a typo; a shortcut that ate it would be a bad trade.
    expect(api.forgetRecentWorkflow).not.toHaveBeenCalled();
  });

  it("does nothing when no row is selected", async () => {
    const { api } = await show([]);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(api.forgetRecentWorkflow).not.toHaveBeenCalled();
  });

  it("moves the selection on, so the keyboard keeps working", async () => {
    await show([
      workflow({ path: "/a.json", name: "Alpha" }),
      workflow({ path: "/b.json", name: "Beta" }),
      workflow({ path: "/c.json", name: "Gamma" }),
    ]);

    fireEvent.click(screen.getByText("Beta").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(screen.queryByText("Beta")).toBeNull());
    expect((screen.getByText("Gamma").closest("button") as HTMLElement).className).toContain(
      "is-selected",
    );
  });

  it("puts the row back if the removal fails", async () => {
    const { api } = await show([workflow({ path: "/a.json", name: "Alpha" })]);
    api.forgetRecentWorkflow.mockRejectedValueOnce(new Error("no"));

    fireEvent.click(screen.getByText("Alpha").closest("button") as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    // A row missing from a list that still holds it would be a lie.
    expect(await screen.findByText(/could not be removed/)).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});

describe("the three list states survive", () => {
  it("says it is looking before the list arrives", () => {
    stub([]);
    render(
      <LaunchWindow onNewWorkflow={() => undefined} onFromPrompt={() => undefined} onOpen={() => undefined}
      onExplain={() => undefined}
      onSettings={() => undefined} />,
    );
    expect(screen.getByText("Looking for your workflows…")).toBeTruthy();
  });

  it("says what to do when there is nothing yet", async () => {
    await show([]);
    expect(screen.getByText(/No workflows yet/)).toBeTruthy();
  });

  it("says when a filter matches nothing", async () => {
    await show([workflow({ path: "/a.json", name: "Alpha" })]);
    fireEvent.change(screen.getByLabelText("Filter recent workflows"), { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });
});

describe("the mark", () => {
  it("is drawn, not a coloured square", async () => {
    await show([]);
    const mark = document.querySelector(".launch-mark") as SVGElement;
    expect(mark.tagName.toLowerCase()).toBe("svg");
    // Ink takes the colour it sits on; only the hill is accent.
    expect(mark.innerHTML).toContain("currentColor");
    expect(mark.innerHTML).toContain("var(--accent)");
  });
});

/**
 * The welcome's place in the launch window.
 *
 * ANT-8's other half: first start only, and a click away afterwards.
 */
/**
 * The explainer is a screen now, not a dialog over this one — it answers what
 * the product is, which is a question you ask before you are inside anything.
 * The launch window's only job is to ask for it.
 */
describe("the way to the explainer", () => {
  it("asks for it from the link, rather than opening one itself", async () => {
    const onExplain = vi.fn();
    const api = stub([]);
    render(
      <LaunchWindow
        onNewWorkflow={() => undefined}
        onFromPrompt={() => undefined}
        onOpen={() => undefined}
        onExplain={onExplain}
      onSettings={() => undefined}
      />,
    );
    await waitFor(() => expect(api.listRecentPlans).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "How Anthill works" }));
    expect(onExplain).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * The second library on the launch screen.
 *
 * ANT-17. An agent profile is written before there is a workflow to put it in,
 * so it belongs on the screen you are already looking at when you have one —
 * not behind a navigation that leaves the workflows.
 */
describe("agents beside the workflows", () => {
  it("opens on workflows, with agents a tab away", async () => {
    await show([workflow({ path: "/a", name: "Nightly review" })]);

    expect(await screen.findByText("Nightly review")).toBeTruthy();
    // Two views of one pane, not the panels of a tablist widget.
    expect(screen.getByRole("group", { name: "Launch library" })).toBeTruthy();
    expect(tab("Agents").getAttribute("aria-current")).toBeNull();
    expect(tab("Workflows").getAttribute("aria-current")).toBe("true");
  });

  it("counts what is behind each tab", async () => {
    await show([workflow({ path: "/a", name: "Nightly review" })]);
    await screen.findByText("Nightly review");

    expect(within(tab("Workflows")).getByText("1")).toBeTruthy();
    expect(within(tab("Agents")).getByText("0")).toBeTruthy();
  });

  it("shows the agent library without opening or creating a workflow", async () => {
    await show([]);
    await screen.findByText(/No workflows yet/);

    fireEvent.click(tab("Agents"));

    expect(await screen.findByText(/No agents of your own yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New agent" })).toBeTruthy();
  });

  /* The workflow list already has its three create actions in the left pane. */
  it("offers + New agent only on the agents tab", async () => {
    await show([]);
    await screen.findByText(/No workflows yet/);
    expect(screen.queryByRole("button", { name: "+ New agent" })).toBeNull();
  });

  it("asks for the thing each list is actually filtered by", async () => {
    await show([]);
    await screen.findByText(/No workflows yet/);
    expect(screen.getByLabelText("Filter recent workflows")).toBeTruthy();

    fireEvent.click(tab("Agents"));
    expect(screen.getByLabelText("Filter agents")).toBeTruthy();
  });

  it("goes back to the workflows it never left", async () => {
    await show([workflow({ path: "/a", name: "Nightly review" })]);
    await screen.findByText("Nightly review");

    fireEvent.click(tab("Agents"));
    expect(screen.queryByText("Nightly review")).toBeNull();

    fireEvent.click(tab("Workflows"));
    expect(screen.getByText("Nightly review")).toBeTruthy();
  });
});

/**
 * Opening a file is opening a file, and nothing else.
 *
 * The button handed the workflow screen an "open" carrying no path, so that
 * screen mounted with nothing to show and fell back to its template picker —
 * and the file dialog opened on top of a page about starting from scratch.
 * Cancelling left the author on that page rather than where they had pressed.
 */
describe("Open Existing Workflow", () => {
  const button = () => screen.getByRole("button", { name: /Open Existing Workflow/ });

  it("asks for a file rather than navigating first", async () => {
    const { api, onOpen } = await show([]);
    fireEvent.click(button());
    await waitFor(() => expect(api.openWorkflow).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stays put when the dialog is cancelled", async () => {
    const { onOpen } = await show([]);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("button", { name: /Open Existing Workflow/ })).toBeTruthy());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens what was chosen, once there is something", async () => {
    const { api, onOpen } = await show([]);
    api.openWorkflow = vi.fn(async () => ({
      ok: true as const,
      opened: { path: "/tmp/chosen.workflow.json", workflow: { name: "Chosen" } },
    })) as never;
    fireEvent.click(button());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/tmp/chosen.workflow.json"));
  });

  it("carries no ellipsis in its label", () => {
    expect(screen.queryByRole("button", { name: /Open Existing Workflow…/ })).toBeNull();
  });
});

/**
 * Which Anthill you are looking at.
 *
 * Two of them run on this machine — the installed one and the one served from
 * the repo — and they look identical while behaving differently, because the
 * repo runs several fixes ahead of the last release. Telling them apart by
 * version number stops working the moment a release catches up.
 */
describe("the dev build badge", () => {
  it("marks a renderer served by the dev server", async () => {
    // vitest runs the renderer the same way the dev server does, so this is
    // the live branch here.
    await show([]);
    expect(screen.getByText("dev build")).toBeTruthy();
  });

  it("keeps saying the version and what the app is", async () => {
    await show([]);
    const line = document.querySelector(".launch-version");
    expect(line?.textContent).toContain(`Version ${__ANTHILL_VERSION__}`);
    expect(line?.textContent).toContain("local-first");
  });

  it("sits beside the version rather than replacing anything", async () => {
    await show([]);
    expect(screen.getByText("dev build").closest(".launch-version")).toBeTruthy();
  });
});

/**
 * A row whose session ended days ago (ANT-84).
 *
 * The dot was read from the live run store, which drops a settled run a day
 * after its last evidence — so a machine used last week looked like a machine
 * never used. The remembered ending fills that in, and the whole risk is that
 * it fills it in *too* confidently: a fortnight-old "Finished" must not be
 * readable as "finished just now".
 */
describe("a workflow whose run is no longer being watched", () => {
  const ended = (state: LiveSessionState, at = "2026-09-08T14:30:00.000Z") =>
    workflow({ path: "/w/one.json", name: "One", workflowId: "w-1", lastRun: { state, at } });

  it("keeps its colour after the run itself is gone", async () => {
    await show([ended("failed")]);
    const mark = document.querySelector(".recent-mark") as HTMLElement;
    expect([...mark.classList]).toContain("tone-bad");
    expect(screen.getByText("Session failed")).toBeTruthy();
  });

  it("says so in the past tense, not as something happening now", async () => {
    await show([ended("completed")]);
    // Quieter than a live chip, and never pulsing.
    expect(document.querySelector(".recent-chip.is-past")).toBeTruthy();
    expect(document.querySelector(".recent-chip.is-pulsing")).toBeNull();
    expect(document.querySelector(".recent-mark.is-past")).toBeTruthy();
  });

  it("shows when it ended, because the state alone would read as now", async () => {
    await show([ended("completed")]);
    expect(screen.getByText("Sep 8")).toBeTruthy();
  });

  it("yields to a live run, so one row never claims two things", async () => {
    // The present outranks a memory of it.
    await show([ended("failed")], [run("detected_live", "w-1")]);
    expect(screen.getByText(/^Live/)).toBeTruthy();
    expect(screen.queryByText("Session failed")).toBeNull();
    expect(document.querySelector(".recent-chip.is-past")).toBeNull();
  });

  it("is grey again when nothing was ever observed", async () => {
    await show([workflow({ path: "/w/two.json", name: "Two", workflowId: "w-2" })]);
    const mark = document.querySelector(".recent-mark") as HTMLElement;
    expect([...mark.classList]).toContain("tone-none");
  });
});
