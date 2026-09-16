/**
 * What the Live Session page is allowed to show, and what it must refuse.
 *
 * The negative assertions are the point. A page that watches an agent work is
 * exactly where a Start or Stop button would feel natural and would be a lie,
 * and where an unmapped event would be quietly attached to whichever step is
 * current. Both are tested for directly.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import type { ObservationEvent, PendingRun } from "@anthill/live";

import { IPC_CONTRACT, LIVE_SESSION_CHANNELS } from "../../shared/ipc.js";
import { LiveSessionPage } from "./LiveSessionPage.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement, test, fix",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    {
      id: "implement",
      type: "agent",
      name: "Make the change",
      config: { actionKind: "agent-step", task: "Write it", agentId: "agent-dev" },
    },
    {
      id: "test",
      type: "agent",
      name: "Run tests",
      config: { actionKind: "verify", task: "Run them", agentId: "agent-qa" },
    },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "implement" },
    { id: "e2", source: "implement", target: "test" },
    { id: "e3", source: "test", target: "end" },
  ],
  metadata: {
    workflow: {
      formatVersion: 4,
      agents: [
        { id: "agent-dev", name: "Developer" },
        { id: "agent-qa", name: "Test Runner" },
      ],
    },
  },
};

function run(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    anthillRunId: "ANT-1A2B3C4D",
    correlationNonce: "9f8e7d",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    createdAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T10:30:00.000Z",
    workflowId: "workflow-1",
    workflowName: "Implement, test, fix",
    state: "detected_live",
    detectedSessionId: "sess-1",
    evidenceChannel: "claude-code:transcript",
    confidence: "strong",
    lastObservedAt: "2026-08-29T10:05:00.000Z",
    ...partial,
  };
}

let seq = 0;
function event(
  partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">,
): ObservationEvent {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: new Date(Date.parse("2026-08-29T10:00:00.000Z") + seq * 1000).toISOString(),
    recordedAt: new Date(Date.parse("2026-08-29T10:00:00.000Z") + seq * 1000).toISOString(),
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    ...partial,
  };
}

/** A main process that serves everything the page needs. */
function stub(events: ObservationEvent[], over: Record<string, unknown> = {}) {
  const api = {
    contract: IPC_CONTRACT,
    capabilities: vi.fn(async () => ({
      contract: IPC_CONTRACT,
      channels: [...LIVE_SESSION_CHANNELS, "app:relaunch"],
    })),
    relaunch: vi.fn(async () => true),
    liveEvents: vi.fn(async () => events),
    onLiveEvents: vi.fn(() => () => undefined),
    liveCancel: vi.fn(async () => ({ runs: [], capabilities: [] })),
    liveLookAgain: vi.fn(async () => ({ runs: [], capabilities: [] })),
    ...over,
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

async function show(
  events: ObservationEvent[],
  pending: PendingRun = run(),
  options: { api?: Record<string, unknown>; observation?: { available: boolean; note: string } } = {},
) {
  const api = stub(events, options.api ?? {});
  const onBack = vi.fn();
  const onStop = vi.fn();
  render(
    <LiveSessionPage
      workflow={workflow}
      run={pending}
      {...(options.observation ? { observation: options.observation } : {})}
      onBack={onBack}
      onStopObserving={onStop}
    />,
  );
  await waitFor(() => expect(api.capabilities).toHaveBeenCalled());
  // A stubbed-stale process never reaches the events channel, and waiting for a
  // call that must not happen is how this helper would hide the fix.
  if (!options.api?.capabilities) {
    await waitFor(() => expect(api.liveEvents).toHaveBeenCalled());
  }
  return { api, onBack, onStop };
}

afterEach(() => {
  delete (window as unknown as { anthill?: unknown }).anthill;
  seq = 0;
});

const step = (blockId: string) =>
  event({ kind: "step.marker", title: "Step announced", detail: blockId, blockId });

describe("the page's read-only boundary", () => {
  it("offers no control that could reach the external session", async () => {
    await show([step("implement")]);
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    for (const forbidden of ["Start", "Run ", "Attach", "Listen", "Watch", "Join", "Resume", "Retry", "Approve", "Pause"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });

  it("says the external session continues when Anthill stops observing", async () => {
    const { onStop } = await show([step("implement")]);
    const stop = screen.getByRole("button", { name: "Stop observing in Anthill" });
    expect(stop.getAttribute("title")).toContain("continues unchanged");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledWith("ANT-1A2B3C4D");
  });

  /**
   * ANT-32. The page has exactly one button that does anything, and offering
   * it on a session that ended hours ago asked to end something already
   * ended. A control that does nothing teaches the reader that the controls
   * here are decorative, which is the opposite of what this page needs.
   */
  describe("whether there is anything left to stop", () => {
    const stopButton = () => screen.queryByRole("button", { name: "Stop observing in Anthill" });

    it("offers it while the session is being followed", async () => {
      await show([step("implement")], run({ state: "detected_live" }));
      expect(stopButton()).toBeTruthy();
    });

    it("keeps it on a session that has only gone quiet", async () => {
      // Still open, so it revives by itself the moment the session writes —
      // which is exactly when someone might want it to stop.
      await show([step("implement")], run({ state: "observation_lost" }));
      expect(stopButton()).toBeTruthy();
    });

    it("drops it once the session is finished", async () => {
      await show([step("implement")], run({ state: "completed" }));
      expect(stopButton()).toBeNull();
    });

    it("drops it on a failed session", async () => {
      await show([step("implement")], run({ state: "failed" }));
      expect(stopButton()).toBeNull();
    });

    it("drops it on a run closed as lost", async () => {
      await show([step("implement")], run({ state: "observation_lost", closedAt: "2026-08-29T10:40:00.000Z" }));
      expect(stopButton()).toBeNull();
    });

    it("removes it rather than disabling it", async () => {
      // A disabled control still asserts that stopping is a thing that
      // applies here.
      await show([step("implement")], run({ state: "completed" }));
      const disabled = [...document.querySelectorAll("button")].filter(
        (button) => (button.textContent ?? "").includes("Stop observing"),
      );
      expect(disabled).toHaveLength(0);
    });

    it("changes the boundary sentence rather than dropping it", async () => {
      // That sentence is doing real work on this page; it should read
      // correctly for a finished run, not vanish with the button.
      await show([step("implement")], run({ state: "completed" }));
      expect(screen.queryByText("Anthill is observing, not running")).toBeNull();
      expect(screen.getByText(/Anthill observed this session/)).toBeTruthy();
    });
  });

  it("states the local and privacy boundary in the header and the panel", async () => {
    await show([step("implement")]);
    expect(screen.getByText("Anthill is observing, not running")).toBeTruthy();
    expect(screen.getByText(/none of the model's reasoning/)).toBeTruthy();
    expect(screen.getByText(/cannot stop, pause or answer it/)).toBeTruthy();
  });

  it("names what it cannot tell you rather than leaving it implied", async () => {
    await show([step("implement")]);
    expect(screen.getByText("What Anthill cannot tell you")).toBeTruthy();
    expect(screen.getByText(/actually following the workflow/)).toBeTruthy();
  });

  it("goes back to the workflow", async () => {
    const { onBack } = await show([]);
    fireEvent.click(screen.getByRole("button", { name: "←" }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("the session header", () => {
  it("carries the workflow, CLI, state, run id, session id, evidence and confidence", async () => {
    await show([step("implement")]);
    expect(screen.getAllByText("Implement, test, fix").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Live session").length).toBeGreaterThan(0);
    // The CLI is named by the presence chip, which reads "Live · Claude Code"
    // as one phrase rather than as a separate label beside a state.
    expect((document.querySelector(".presence-label") as HTMLElement).textContent).toContain(
      "Claude Code",
    );
    expect(screen.getByText("ANT-1A2B3C4D")).toBeTruthy();
    expect(screen.getByText("sess-1")).toBeTruthy();
    expect(screen.getAllByText("claude-code:transcript").length).toBeGreaterThan(0);
    expect(screen.getByText("strong")).toBeTruthy();
  });
});

describe("the workflow progress view", () => {
  it("shows the announced step working and the one it left as done", async () => {
    await show([step("implement"), step("test")]);
    const graph = document.querySelector(".live-graph") as SVGElement;
    expect(within(graph as unknown as HTMLElement).getByText("Make the change")).toBeTruthy();
    expect(graph.querySelector(".live-node.state-running")).toBeTruthy();
    expect(graph.querySelector(".live-node.state-done")).toBeTruthy();
  });

  it("moves nothing when the agent never announced a step", async () => {
    await show([
      event({ kind: "session.start", title: "Session started" }),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
    ]);
    expect(document.querySelector(".live-node.state-running")).toBeNull();
    expect(screen.getByText(/has not announced a step yet/)).toBeTruthy();
  });

  it("shows a step waiting on a person differently from one working", async () => {
    await show([
      step("implement"),
      event({ kind: "notification", title: "Waiting for you", detail: "permission to run tests" }),
    ]);
    expect(document.querySelector(".live-node.state-needsYou")).toBeTruthy();
    expect(document.querySelector(".live-node.state-running")).toBeNull();
  });

  it("draws a failed step without any of the running treatment", async () => {
    await show([step("test"), event({ kind: "error", title: "Failed", detail: "3 tests failed" })]);
    const failed = document.querySelector(".live-node.state-failed");
    expect(failed).toBeTruthy();
    // Nothing moves on a settled block, and it wears one border like the rest.
    expect(failed?.getAttribute("class")).not.toContain("moves");
    expect(failed?.querySelectorAll("rect").length).toBe(1);
    expect(failed?.querySelector(".live-slide")).toBeNull();
  });

  it("marks a step unknown once observation is lost", async () => {
    await show([step("implement")], run({ state: "observation_lost" }));
    expect(document.querySelector(".live-node.state-unknown")).toBeTruthy();
  });
});

describe("the activity feed", () => {
  it("counts unmapped activity on the canvas instead of hiding it", async () => {
    await show([
      event({ kind: "tool.start", title: "Read", toolName: "Read" }),
      event({ kind: "tool.start", title: "Grep", toolName: "Grep" }),
    ]);
    expect(screen.getByText("2 events not mapped to a workflow step")).toBeTruthy();
  });

  it("makes one card per action, not one per record", async () => {
    // Two records for one Bash call. A reader should be told about one thing.
    await show([
      event({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "t1" }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "t1", durationMs: 2400 }),
    ]);
    expect(document.querySelectorAll(".feed-card").length).toBe(1);
    expect(screen.getByText("Completed · 2.4s")).toBeTruthy();
  });

  it("states its confidence as a word, never as a colour alone", async () => {
    await show([step("implement"), event({ kind: "tool.start", title: "Bash", toolName: "Bash" })]);
    expect(document.querySelectorAll(".feed-card").length).toBe(2);
    expect(screen.getByText("Confirmed · Make the change")).toBeTruthy();
    expect(screen.getByText("Likely · Make the change")).toBeTruthy();
  });

  it("says plainly when nothing tied a card to a step", async () => {
    await show([event({ kind: "tool.start", title: "Read", toolName: "Read" })]);
    expect(screen.getByText("Not mapped to a workflow step")).toBeTruthy();
  });

  it("gives the runtime's own name for an agent rather than inventing one", async () => {
    await show([
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "test-runner" }),
    ]);
    // The runtime's own word appears once, on its own line — the card is
    // titled by what the record said happened, not by the same string twice.
    expect(screen.getByText("test-runner")).toBeTruthy();
    expect(screen.getByText(/Runtime:/)).toBeTruthy();
    // The card is titled with the step's own agent profile, so the runtime's
    // word is printed once, on the Runtime line, and never as the title too.
    expect(document.querySelector(".feed-card-title")?.textContent).toBe("Test Runner");
  });

  it("opens a card to show the record it came from", async () => {
    await show([
      event({
        kind: "tool.end",
        title: "Bash",
        toolName: "Bash",
        toolUseId: "call-9",
        durationMs: 2400,
        source: "hook",
        channel: "claude-code:hook",
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    expect(screen.getByText("claude-code:hook")).toBeTruthy();
    expect(screen.getByText("call-9")).toBeTruthy();
    expect(screen.getByText("tool.end")).toBeTruthy();
    // The mapping is stated in words, so a guess can never pass as a fact.
    expect(screen.getByText("nothing in the record names a step")).toBeTruthy();
  });

  it("has a useful empty state before anything is observed", async () => {
    await show([]);
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
  });

  it("filters the feed to one step when a block is selected", async () => {
    await show([step("implement"), step("test")]);
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(within(graph).getByText("Run tests").closest("g") as Element);

    const chip = document.querySelector(".scope-chip") as HTMLElement;
    expect(within(chip).getByText("Run tests")).toBeTruthy();
    expect(document.querySelectorAll(".feed-card").length).toBe(1);

    fireEvent.click(within(chip).getByRole("button", { name: "Show the whole session" }));
    expect(document.querySelector(".scope-chip")).toBeNull();
    expect(document.querySelectorAll(".feed-card").length).toBe(2);
  });

  it("shows the newest card first, so a growing session never buries it", async () => {
    await show([step("implement"), step("test")]);
    const cards = [...document.querySelectorAll(".feed-card")];
    expect(cards[0].textContent).toContain("Run tests");
  });

  it("filters by kind from chips, and says how much of the scope is showing", async () => {
    await show([
      step("implement"),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
      event({ kind: "session.start", title: "Session started" }),
    ]);
    expect(screen.getByText("3 cards")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(document.querySelectorAll(".feed-card").length).toBe(1);
  });

  it("separates nothing matching a filter from nothing having happened", async () => {
    await show([event({ kind: "session.start", title: "Session started" })]);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("Nothing matches this filter.")).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded yet/)).toBeNull();
  });

  it("explains an empty step scope rather than leaving it blank", async () => {
    await show([step("implement")]);
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(within(graph).getByText("Run tests").closest("g") as Element);
    expect(screen.getByText(/Nothing mapped to this step/)).toBeTruthy();
  });
});

describe("how the edges are drawn", () => {
  it("greens the edge out of a step the run has left", async () => {
    await show([step("implement"), step("test")]);
    // start → implement is travelled; implement → test is the live one; and
    // test → end has not been taken, so it stays idle.
    expect(document.querySelectorAll(".live-edge.tone-seen").length).toBe(1);
    expect(document.querySelectorAll(".live-edge.tone-idle").length).toBe(1);
  });

  it("flows only the edge that delivered control, not every edge arriving", async () => {
    await show([step("implement"), step("test")]);
    const live = document.querySelectorAll(".live-edge.tone-live");
    expect(live.length).toBe(1);
  });

  it("leaves every edge idle before anything has been observed", async () => {
    await show([]);
    expect(document.querySelectorAll(".live-edge.tone-live").length).toBe(0);
    expect(document.querySelectorAll(".live-edge.tone-seen").length).toBe(0);
  });
});

describe("when the process behind the page is out of date", () => {
  it("says a restart is needed instead of showing an empty feed", async () => {
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => {
          throw new Error("No handler registered for 'app:capabilities'");
        }),
      },
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Live Session needs a restart")).toBeTruthy();
    expect(screen.getByText(/needs an Anthill restart to enable this feature/)).toBeTruthy();
    // The sentence that used to be shown, and would have been a lie.
    expect(screen.queryByText(/Nothing recorded yet/)).toBeNull();
  });

  it("never subscribes to a channel the running process does not serve", async () => {
    const { api } = await show([], run(), {
      api: {
        capabilities: vi.fn(async () => ({ contract: IPC_CONTRACT, channels: ["live:snapshot"] })),
        liveEvents: vi.fn(async () => []),
        onLiveEvents: vi.fn(() => () => undefined),
      },
    });

    await screen.findByRole("alert");
    expect(api.liveEvents).not.toHaveBeenCalled();
    expect(api.onLiveEvents).not.toHaveBeenCalled();
  });

  it("names the missing channel so the report is actionable", async () => {
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => ({ contract: IPC_CONTRACT, channels: ["live:snapshot"] })),
      },
    });
    await screen.findByRole("alert");
    expect(screen.getByText("live:events")).toBeTruthy();
  });

  it("offers a restart only when the running process can perform one", async () => {
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => ({
          contract: IPC_CONTRACT,
          channels: ["live:snapshot", "app:relaunch"],
        })),
      },
    });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Restart Anthill" })).toBeTruthy();
  });

  it("tells the user to restart it themselves when Anthill cannot", async () => {
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => {
          throw new Error("No handler registered for 'app:capabilities'");
        }),
      },
    });
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Restart Anthill" })).toBeNull();
    expect(screen.getByText(/Quit Anthill and open it again/)).toBeTruthy();
  });

  it("actually restarts, and says so honestly when the user cancels", async () => {
    const relaunch = vi.fn(async () => false);
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => ({
          contract: IPC_CONTRACT,
          channels: ["live:snapshot", "app:relaunch"],
        })),
        relaunch,
      },
    });
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Restart Anthill" }));
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
    // A cancelled restart must not be reported as one that happened.
    expect(await screen.findByText("Not restarted. Nothing has changed.")).toBeTruthy();
  });

  it("stops the diagram claiming progress it could not read", async () => {
    await show([], run(), {
      api: {
        capabilities: vi.fn(async () => {
          throw new Error("No handler registered for 'app:capabilities'");
        }),
      },
    });
    await screen.findByRole("alert");
    expect(screen.getByText("2 steps · progress unknown")).toBeTruthy();
    expect(screen.queryByText(/has not announced a step yet/)).toBeNull();
  });
});

describe("when reading the activity fails for another reason", () => {
  it("shows the failure rather than an empty list", async () => {
    await show([], run(), {
      api: { liveEvents: vi.fn(async () => Promise.reject(new Error("journal unreadable"))) },
    });

    expect(await screen.findByText(/journal unreadable/)).toBeTruthy();
    expect(screen.getByText(/not a statement that nothing happened/)).toBeTruthy();
  });

  it("shows a failed subscription even when the first read succeeded", async () => {
    await show([], run(), {
      api: {
        onLiveEvents: vi.fn(() => {
          throw new Error("bridge closed");
        }),
      },
    });

    expect(await screen.findByText(/bridge closed/)).toBeTruthy();
  });

  it("says the CLI writes nothing readable, rather than showing an empty feed", async () => {
    await show([], run(), {
      observation: {
        available: false,
        note: "Claude Code has written no local sessions on this machine.",
      },
    });

    expect(await screen.findByText(/no local sessions on this machine/)).toBeTruthy();
    expect(screen.getByText(/not the same as nothing happening/)).toBeTruthy();
  });
});

describe("the ordinary empty feed", () => {
  it("stays an ordinary empty state, with no alarm attached", async () => {
    await show([]);
    expect(await screen.findByText(/Nothing recorded yet/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/needs a restart/)).toBeNull();
    expect(screen.getByText("2 steps · none announced yet")).toBeTruthy();
  });

  it("subscribes normally when the process is compatible", async () => {
    const { api } = await show([step("implement")]);
    expect(api.liveEvents).toHaveBeenCalledWith("ANT-1A2B3C4D");
    expect(api.onLiveEvents).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});


describe("a run whose workflow is not the one on screen", () => {
  /**
   * A run remembers its workflow's id and name, never the diagram. Folding it
   * against whatever happens to be open drew the wrong workflow's blocks and marked
   * every event in the session "no step" — which reads as a finding about the
   * session rather than what it was, a question Anthill could not answer.
   */
  const elsewhere = run({
    workflowId: "workflow-other",
    workflowName: "Multi-agent coordination",
    state: "completed",
  });

  it("says which workflow the run came from instead of drawing this one", async () => {
    await show([step("implement"), event({ kind: "turn.end", title: "Finished the turn" })], elsewhere);

    expect(screen.getByText(/this run\u2019s workflow is not open/i)).toBeTruthy();
    expect(screen.getAllByText("Multi-agent coordination").length).toBeGreaterThan(1);
    expect(screen.getByText("Implement, test, fix")).toBeTruthy();
    expect(document.querySelector(".live-graph-surface")).toBeNull();
  });

  it("does not claim a step count or a progress figure it cannot support", async () => {
    await show([step("implement")], elsewhere);
    expect(screen.queryByText(/steps finished/)).toBeNull();
    expect(screen.queryByText(/none announced yet/)).toBeNull();
    expect(screen.queryByText(/not mapped to a step/)).toBeNull();
  });

  it("marks no event against a workflow that is not the run's", async () => {
    // The markers name the other workflow's blocks, so against this one every
    // event falls through as unattributed. Saying "no step" about each of them
    // reads as a fact about the session rather than about the wrong diagram.
    await show([step("area-a"), event({ kind: "tool.start", title: "Read" })], elsewhere);
    expect(screen.queryByText("no step")).toBeNull();
  });

  it("still shows the session's own activity", async () => {
    await show([event({ kind: "tool.start", title: "Read the file" })], elsewhere);
    expect(screen.getByText("Read the file")).toBeTruthy();
  });

  it("draws the graph as usual when the workflow on screen is the run's", async () => {
    await show([step("implement")]);
    expect(document.querySelector(".live-graph-surface")).toBeTruthy();
    expect(screen.queryByText(/this run\u2019s workflow is not open/i)).toBeNull();
  });
});


describe("how fresh the page says its evidence is", () => {
  it("keeps counting after the session stops writing", async () => {
    // The last render happens when the last event arrives. Without a clock of
    // its own the rail kept whatever it drew then, so a session that ended five
    // minutes ago still read "1s ago" — the label is most wrong in exactly the
    // case it exists for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ended = new Date().toISOString();
      await show(
        [event({ kind: "turn.end", title: "Finished the turn", at: ended })],
        run({ state: "completed", lastObservedAt: ended }),
      );

      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(screen.getByText(/^\d+m ago$/)).toBeTruthy();
      expect(screen.queryByText(/^\ds ago$/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The limit the page did not admit to.
 *
 * ANT-18. When a session hands a stage to another agent, the record keeps the
 * handover and the result and loses the work — which is both why the graph
 * shows unmapped activity and why Anthill must not read the silence that
 * follows as an ending.
 */
describe("a session that handed work to another agent", () => {
  it("says what it cannot see, once there is something it cannot see", async () => {
    await show([
      event({ kind: "tool.start", title: "SendMessage", toolName: "SendMessage" }),
    ]);
    expect(screen.getByText(/the record\s+has the handover, not the work/)).toBeTruthy();
  });

  it("stays quiet about it when nothing was handed over", async () => {
    await show([event({ kind: "tool.start", title: "Bash", toolName: "Bash" })]);
    expect(screen.queryByText(/has the handover, not the work/)).toBeNull();
  });
});

/**
 * Delegating is not the same hole as handing over, and used to be told as one.
 *
 * Both once produced the sentence about "the handover, not the work", which is
 * true of a handover and misleading of a delegation: a subagent's *steps* do
 * arrive and do move the diagram — it is only its turns that are never written
 * into this session's transcript, which is why its messages cannot appear in
 * the feed (ANT-54). A reader looking for that message is owed the actual
 * reason rather than a sentence about a different gap.
 */
describe("a session that delegated to a subagent", () => {
  it("names the one part that cannot be shown", async () => {
    await show([
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "Developer" }),
    ]);
    expect(screen.getByText(/What a subagent said/)).toBeTruthy();
  });

  it("does not describe it as a handover to another session", async () => {
    await show([
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "Developer" }),
    ]);
    expect(screen.queryByText(/has the handover, not the work/)).toBeNull();
  });

  it("says nothing of the sort when no subagent ran", async () => {
    await show([event({ kind: "tool.start", title: "Bash", toolName: "Bash" })]);
    expect(screen.queryByText(/What a subagent said/)).toBeNull();
  });

  it("tells both apart when a session did both", async () => {
    await show([
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "Developer" }),
      event({ kind: "tool.start", title: "SendMessage", toolName: "SendMessage" }),
    ]);
    expect(screen.getByText(/What a subagent said/)).toBeTruthy();
    expect(screen.getByText(/has the handover, not the work/)).toBeTruthy();
  });
});

/**
 * A message card describes a message, not an outcome.
 *
 * From the In Review audit: "Completed" under a sentence reads as a claim
 * about the sentence — or worse, about the workflow — when all it ever meant
 * was that the row was ingested. Tools keep their outcome line; words do not
 * get one.
 */
describe("what a message card claims", () => {
  it("carries no outcome language", async () => {
    await show([
      event({ kind: "message", title: "The agent wrote", detail: "Starting on the tests now." }),
    ]);
    expect(screen.getByText("Starting on the tests now.")).toBeTruthy();
    const card = document.querySelector(".feed-card.kind-message") as Element;
    expect(card.querySelector(".feed-state")).toBeNull();
    expect(card.querySelector(".feed-glyph")).toBeNull();
  });

  it("leaves a tool's outcome line exactly as it was", async () => {
    await show([
      event({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "t1" }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "t1", ok: true }),
    ]);
    const card = document.querySelector(".feed-card.kind-tool") as Element;
    expect(card.querySelector(".feed-state")).toBeTruthy();
  });
});

/**
 * The one control a lost session gets.
 *
 * ANT-20. "Look again" is a control over what Anthill reads — the only thing
 * Anthill owns — and the words around it must not read as control over the
 * session. It appears only for a run Anthill closed as lost: an open lost run
 * revives by itself, and a cancelled run has no record to press a button on.
 */
describe("looking again from the page", () => {
  it("offers Look again on a closed lost run, with the boundary stated", async () => {
    await show([], run({ state: "observation_lost", closedAt: "2026-08-29T10:40:00.000Z" }));
    const button = screen.getByRole("button", { name: "Look again" });
    expect(button).toBeTruthy();
    expect(screen.getByText(/Nothing is\s+sent to the session/)).toBeTruthy();
  });

  it("asks main to re-read when pressed", async () => {
    const lookAgain = vi.fn(async () => ({ runs: [], capabilities: [] }));
    await show([], run({ state: "observation_lost", closedAt: "2026-08-29T10:40:00.000Z" }), {
      api: { liveLookAgain: lookAgain },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    expect(lookAgain).toHaveBeenCalledWith("ANT-1A2B3C4D");
  });

  it("does not offer it while the run is still open — Anthill is already reading", async () => {
    await show([], run({ state: "observation_lost" }));
    expect(screen.queryByRole("button", { name: "Look again" })).toBeNull();
  });

  it("does not offer it on a finished or failed run", async () => {
    for (const state of ["completed", "failed"] as const) {
      await show([], run({ state, closedAt: "2026-08-29T10:40:00.000Z" }));
      expect(screen.queryByRole("button", { name: "Look again" })).toBeNull();
      cleanup();
    }
  });

  it("never words it as control over the session", async () => {
    await show([], run({ state: "observation_lost", closedAt: "2026-08-29T10:40:00.000Z" }));
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    for (const forbidden of ["Attach", "Resume session", "Reconnect", "Restart"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });
});

/**
 * The summary a settled session has earned.
 *
 * ANT-21 / ANT-9. Two tiers, and the tests hold them apart: durations come
 * from the agent's own announcements; tokens are what the harness recorded,
 * labelled recorded rather than total, "Likely" where attribution is an
 * inference, and "not recorded" — never zero — where there is nothing.
 */
describe("the settled session's summary", () => {
  const settled = () =>
    run({
      state: "completed",
      lastObservedAt: "2026-08-29T10:12:00.000Z",
    });

  const usage = (tokens: { in: number; out: number }, at: string) =>
    event({ kind: "usage", title: "Token usage recorded", tokens, at });

  it("appears only once the run has settled", async () => {
    await show([step("implement")], run({ state: "detected_live" }));
    expect(document.querySelector(".session-summary")).toBeNull();
    cleanup();

    await show([step("implement")], settled());
    expect(document.querySelector(".session-summary")).toBeTruthy();
  });

  it("times each announced step from its own markers", async () => {
    await show(
      [
        event({ kind: "step.marker", title: "Step announced", blockId: "implement", at: "2026-08-29T10:00:00.000Z" }),
        event({ kind: "step.marker", title: "Step announced", blockId: "test", at: "2026-08-29T10:04:00.000Z" }),
      ],
      settled(),
    );
    const rows = [...document.querySelectorAll(".summary-steps tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("Make the change");
    expect(rows[0]).toContain("4m");
  });

  it("says tokens were not recorded rather than showing zero", async () => {
    await show([step("implement")], settled());
    expect(screen.getByText("not recorded")).toBeTruthy();
    expect(screen.queryByText(/^0 in/)).toBeNull();
  });

  it("labels per-step tokens as the inference they are", async () => {
    await show(
      [
        event({ kind: "step.marker", title: "Step announced", blockId: "implement", at: "2026-08-29T10:00:00.000Z" }),
        usage({ in: 1200, out: 300 }, "2026-08-29T10:01:00.000Z"),
      ],
      settled(),
    );
    const summary = document.querySelector(".session-summary") as Element;
    expect(summary.textContent).toContain("1,200 in · 300 out");
    expect(summary.querySelector(".conf-likely")).toBeTruthy();
  });

  it("owns the boundary: the harness measured, Anthill did not", async () => {
    await show([step("implement")], settled());
    expect(screen.getByText(/Anthill measured nothing/)).toBeTruthy();
  });

  it("keeps usage rows out of the feed and the unmapped count", async () => {
    await show([usage({ in: 10, out: 5 }, "2026-08-29T10:01:00.000Z")], run());
    expect(document.querySelector(".feed-card")).toBeNull();
    expect(screen.queryByText(/not mapped to a workflow step/)).toBeNull();
  });
});

/**
 * The one motion in the feed.
 *
 * It exists to say a card *arrived*, so what it must never do is play for a
 * card that was simply re-rendered — and it must not play at all for the
 * batch that was already there when the screen opened, none of which just
 * happened. The mark is one held id rather than a flag on whichever card sits
 * at the top, which is what makes both of those true.
 */
describe("the arrival", () => {
  /** Render, then push a later journal through the live channel. */
  async function arrive(first: ObservationEvent[], then: ObservationEvent[]) {
    let push: ((payload: { runId: string; events: ObservationEvent[] }) => void) | undefined;
    await show(first, run(), {
      api: {
        onLiveEvents: vi.fn((listener: (payload: { runId: string; events: ObservationEvent[] }) => void) => {
          push = listener;
          return () => undefined;
        }),
      },
    });
    await waitFor(() => expect(push).toBeTruthy());
    act(() => push?.({ runId: "ANT-1A2B3C4D", events: [...first, ...then] }));
    return () => [...document.querySelectorAll(".feed-card")];
  }

  const marked = (cards: Element[]) =>
    cards.filter((card) => card.className.includes("event-new")).length;

  it("animates nothing on the first read", async () => {
    // Everything in it was already there before the screen opened.
    await show([step("implement"), step("test")]);
    expect(marked([...document.querySelectorAll(".feed-card")])).toBe(0);
  });

  it("marks the card that arrived, and only that one", async () => {
    const cards = await arrive([step("implement")], [step("test")]);
    expect(marked(cards())).toBe(1);
    expect(cards()[0].className).toContain("event-new");
    expect(cards()[0].textContent).toContain("Run tests");
  });

  it("does not hand the mark to whatever the filter puts on top", async () => {
    // The mark is the card's id, not its position. Filtering the arrival out
    // of view must not promote the card that takes its place.
    const tool = event({ kind: "tool.start", title: "Bash", toolName: "Bash" });
    const cards = await arrive([tool], [event({ kind: "message", title: "m", detail: "Done." })]);
    expect(cards()[0].className).toContain("event-new");

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(cards()).toHaveLength(1);
    expect(marked(cards())).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(cards()[0].className).toContain("event-new");
  });

  it("hands the mark on rather than accumulating it", async () => {
    const cards = await arrive([step("implement")], [step("test"), step("implement")]);
    expect(marked(cards())).toBe(1);
    expect(cards()[0].className).toContain("event-new");
  });

  it("does not animate the bottom card under oldest-first", async () => {
    const cards = await arrive([step("implement")], [step("test")]);
    fireEvent.change(screen.getByLabelText("Order"), { target: { value: "oldest" } });
    expect(marked(cards())).toBe(0);
  });
});

/**
 * How long the run has been going.
 *
 * The rail already says when it started and when it was last seen, which
 * leaves the reader doing arithmetic across two lines to answer the question
 * they actually have.
 *
 * Measured from the events rather than by pushing the clock about: fake timers
 * stop the polling `waitFor` in `show` from ever resolving, and a test that
 * has to disable the harness to run is testing the harness.
 */
describe("the session's own elapsed time", () => {
  /** The <dd> that follows the Elapsed label in the session rail. */
  function elapsed(): string {
    const term = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === "Elapsed");
    return term?.nextElementSibling?.textContent ?? "";
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("measures a live session up to now, not to its last record", async () => {
    // Started 95 and a half minutes ago; its last record is much older than
    // that would suggest, and the answer follows the clock rather than it.
    await show(
      [
        event({ kind: "tool.start", title: "Bash", at: ago(95 * 60_000 + 30_000) }),
        event({ kind: "tool.end", title: "Bash", at: ago(90 * 60_000) }),
      ],
      run(),
    );
    expect(elapsed()).toBe("1h 35m");
  });

  it("stops at the last thing observed once the session is over", async () => {
    // Hours ago on the clock, but the session itself ran for 42 minutes.
    await show(
      [
        event({ kind: "tool.start", title: "Bash", at: ago(5 * 3600_000) }),
        event({ kind: "tool.end", title: "Bash", at: ago(5 * 3600_000 - 42 * 60_000) }),
      ],
      run({ state: "completed" }),
    );
    expect(elapsed()).toBe("42m");
  });

  it("counts no further than the last sighting of a session it lost", async () => {
    // Anthill cannot see it any more, so it does not claim the hours since.
    await show(
      [
        event({ kind: "tool.start", title: "Bash", at: ago(3 * 3600_000) }),
        event({ kind: "tool.end", title: "Bash", at: ago(3 * 3600_000 - 20 * 60_000) }),
      ],
      run({ state: "observation_lost" }),
    );
    expect(elapsed()).toBe("20m");
  });

  it("says nothing at all before there is anything to measure", async () => {
    await show([], run());
    expect(elapsed()).toBe("—");
  });
});

/**
 * What the page is still entitled to apologise for.
 *
 * The rail carried a standing note that a subagent's words were not written
 * down to show. They were (ANT-54). A page that keeps apologising for
 * something it now does teaches the reader to discount the rest of that list,
 * so the note is gated on what actually arrived rather than on a claim about
 * what can.
 */
describe("the note about what a subagent said", () => {
  const NOTE = /What a subagent said/;

  it("is gone once the delegate's own words are in the feed", async () => {
    await show([
      event({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "t1" }),
      event({
        kind: "message",
        title: "Subagent",
        detail: "Nine schemas parse.",
        author: { kind: "subagent", name: "developer" },
      }),
    ]);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("stays for a delegation whose words never arrived", async () => {
    // Codex has no subagent concept to record, and an old journal has no
    // delegate transcripts behind it. The reader is still owed the note.
    await show([event({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "t1" })]);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it("is never shown for a session that delegated nothing", async () => {
    await show([event({ kind: "tool.start", title: "Bash", toolUseId: "t1" })]);
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
