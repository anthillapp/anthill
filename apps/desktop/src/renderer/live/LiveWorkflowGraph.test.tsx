/**
 * Zoom on a read-only diagram.
 *
 * The Workflow canvas already taught these gestures, so the behaviour matches it
 * deliberately — the same limits, the same step, the same ⌘+/−/0. What must not
 * match is the editing: this graph pans and zooms and does nothing else.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import {
  foldLiveSession,
  createPendingRun,
  type ObservationEvent,
  type PendingRun,
} from "@anthill/live";

import { LiveWorkflowGraph, ZOOM_MAX, ZOOM_MIN } from "./LiveWorkflowGraph.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement, test, fix",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "implement",
      type: "agent",
      name: "Make the change",
      config: { actionKind: "agent-step", task: "Write it" },
      position: { x: 300, y: 0 },
    },
    { id: "end", type: "end", name: "Done", config: {}, position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "implement" },
    { id: "e2", source: "implement", target: "end" },
  ],
  metadata: { workflow: { formatVersion: 4 } },
};

const run: PendingRun = {
  ...createPendingRun({
    anthillRunId: "ANT-1",
    correlationNonce: "nnnn",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd",
    now: "2026-08-29T10:00:00.000Z",
  }),
  state: "detected_live",
};

function show() {
  const onSelect = vi.fn();
  const view = foldLiveSession(workflow, run, []);
  render(
    <LiveWorkflowGraph
      workflow={workflow}
      view={view}
      sessionState={run.state}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

const level = () => screen.getByTestId("live-zoom-level").textContent ?? "";
const zoomIn = () => screen.getByRole("button", { name: "Zoom in" });
const zoomOut = () => screen.getByRole("button", { name: "Zoom out" });

/** Same helper as the workflow's, for the same act() reason. */
function wheel(
  target: Element,
  init: { deltaY: number; deltaX?: number; ctrlKey?: boolean },
) {
  return fireEvent.wheel(target, { deltaX: 0, ctrlKey: false, clientX: 100, clientY: 100, ...init });
}

const surface = () => document.querySelector(".live-graph-surface") as HTMLElement;

describe("trackpad gestures on the read-only graph", () => {
  it("zooms in on a spreading pinch", () => {
    show();
    const before = Number.parseInt(level(), 10);
    wheel(surface(), { deltaY: -30, ctrlKey: true });
    expect(Number.parseInt(level(), 10)).toBeGreaterThan(before);
  });

  it("zooms in when two fingers move up, out when they move down", () => {
    show();
    const start = Number.parseInt(level(), 10);
    wheel(surface(), { deltaY: 40 });
    const up = Number.parseInt(level(), 10);
    expect(up).toBeGreaterThan(start);

    wheel(surface(), { deltaY: -40 });
    expect(Number.parseInt(level(), 10)).toBeLessThan(up);
  });

  it("takes the event, so the window does not zoom with it", () => {
    show();
    expect(wheel(surface(), { deltaY: -30, ctrlKey: true })).toBe(false);
  });

  it("moves the same zoom the buttons and the readout use", () => {
    show();
    wheel(surface(), { deltaY: 40 });
    const gestured = Number.parseInt(level(), 10);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(Number.parseInt(level(), 10)).toBeLessThan(gestured);
  });

  it("honours Show whole workflow after a gesture", () => {
    show();
    for (let i = 0; i < 8; i += 1) wheel(surface(), { deltaY: 40 });
    const zoomed = Number.parseInt(level(), 10);
    fireEvent.click(screen.getByRole("button", { name: "Show whole workflow" }));
    expect(Number.parseInt(level(), 10)).toBeLessThan(zoomed);
  });

  it("stops at the bounds under sustained momentum", () => {
    show();
    for (let i = 0; i < 150; i += 1) wheel(surface(), { deltaY: 200 });
    expect(Number.parseInt(level(), 10)).toBe(Math.round(ZOOM_MAX * 100));
    for (let i = 0; i < 250; i += 1) wheel(surface(), { deltaY: -200 });
    expect(Number.parseInt(level(), 10)).toBe(Math.round(ZOOM_MIN * 100));
  });

  it("changes nothing about the workflow, however much it is gestured at", () => {
    const { onSelect } = show();
    const before = JSON.stringify(workflow);
    for (let i = 0; i < 20; i += 1) wheel(surface(), { deltaY: 40, ctrlKey: i % 2 === 0 });

    // Read-only means read-only: the gesture moves a viewport and nothing else.
    // There is no onChange to call, and the workflow it was handed is untouched.
    expect(JSON.stringify(workflow)).toBe(before);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector(".live-graph input, .live-graph textarea")).toBeNull();
  });

  it("leaves the activity feed's own scrolling alone", () => {
    show();
    const feed = document.createElement("div");
    feed.className = "live-side";
    document.body.appendChild(feed);

    const before = level();
    expect(wheel(feed, { deltaY: 40 })).toBe(true);
    expect(level()).toBe(before);
    feed.remove();
  });
});

describe("the Live Session zoom controls", () => {
  it("offers zoom out, a readable level, zoom in, and fit", () => {
    show();
    const group = screen.getByRole("group", { name: "Diagram zoom" });
    expect(within(group).getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Show whole workflow" })).toBeTruthy();
    expect(level()).toMatch(/^\d+%$/);
  });

  it("announces the level to assistive technology as it changes", () => {
    show();
    const readout = screen.getByTestId("live-zoom-level");
    expect(readout.getAttribute("role")).toBe("status");
    expect(readout.getAttribute("aria-live")).toBe("polite");
  });

  it("zooms in and out in steps", () => {
    show();
    const before = Number.parseInt(level(), 10);
    fireEvent.click(zoomIn());
    const after = Number.parseInt(level(), 10);
    expect(after).toBeGreaterThan(before);
    fireEvent.click(zoomOut());
    expect(Number.parseInt(level(), 10)).toBe(before);
  });

  it("stops at the upper bound rather than running away", () => {
    show();
    for (let i = 0; i < 30; i += 1) fireEvent.click(zoomIn());
    expect(Number.parseInt(level(), 10)).toBe(Math.round(ZOOM_MAX * 100));
    expect((zoomIn() as HTMLButtonElement).disabled).toBe(true);
  });

  it("stops at the lower bound, so the workflow can never vanish", () => {
    show();
    for (let i = 0; i < 30; i += 1) fireEvent.click(zoomOut());
    expect(Number.parseInt(level(), 10)).toBe(Math.round(ZOOM_MIN * 100));
    expect((zoomOut() as HTMLButtonElement).disabled).toBe(true);
  });

  it("comes back to a whole-workflow view after zooming right in", () => {
    show();
    for (let i = 0; i < 10; i += 1) fireEvent.click(zoomIn());
    const zoomed = Number.parseInt(level(), 10);
    fireEvent.click(screen.getByRole("button", { name: "Show whole workflow" }));
    expect(Number.parseInt(level(), 10)).toBeLessThan(zoomed);
  });

  it("zooms the diagram from the keyboard, not the window", () => {
    show();
    const before = Number.parseInt(level(), 10);
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(Number.parseInt(level(), 10)).toBeGreaterThan(before);
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(Number.parseInt(level(), 10)).toBe(before);
  });

  it("leaves the shortcut alone while someone is typing", () => {
    show();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    const before = level();
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    // `+` and `-` are ordinary characters in a field, and a shortcut that ate
    // them would be worse than no shortcut.
    expect(level()).toBe(before);
    field.remove();
  });

  it("ignores a bare + with no modifier", () => {
    show();
    const before = level();
    fireEvent.keyDown(window, { key: "+" });
    expect(level()).toBe(before);
  });

  it("still lets a step be selected, and still edits nothing", () => {
    const { onSelect } = show();
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(within(graph).getByText("Make the change").closest("g") as Element);
    expect(onSelect).toHaveBeenCalledWith("implement");
    // Read-only: there is nothing here that could change the workflow.
    expect(graph.querySelector("input, textarea, select")).toBeNull();
  });
});

/**
 * What Start is allowed to say.
 *
 * ANT-14. A session is normally alive for a while before it announces its
 * first step — it reads the prompt, opens files, runs something. Start went
 * green on the very first event of any kind, so that stretch looked like a
 * workflow already under way. The session beginning and the workflow beginning
 * are different facts and the diagram now keeps them apart.
 */
describe("the Start block before any step is announced", () => {
  let seq = 0;
  function event(kind: ObservationEvent["kind"], title: string, at: string): ObservationEvent {
    seq += 1;
    return {
      runId: "ANT-1",
      seq,
      at,
      recordedAt: at,
      cli: "claude-code",
      source: "transcript",
      channel: "claude-code:transcript",
      kind,
      title,
    };
  }

  const marker = (): ObservationEvent => ({
    ...event("step.marker", "implement", "2026-08-29T10:00:30.000Z"),
    blockId: "implement",
  });

  function draw(events: ObservationEvent[], state: PendingRun["state"] = "detected_live") {
    const withState = { ...run, state };
    const view = foldLiveSession(workflow, withState, events);
    const { unmount } = render(
      <LiveWorkflowGraph
        workflow={workflow}
        view={view}
        sessionState={state}
        onSelect={vi.fn()}
      />,
    );
    const start = [...document.querySelectorAll(".live-node")].find((el) =>
      el.querySelector("title")?.textContent?.startsWith("Start"),
    ) as Element;
    return { start, unmount };
  }

  it("says it is waiting, not that it is finished", () => {
    const { start } = draw([event("tool.start", "Read", "2026-08-29T10:00:05.000Z")]);
    expect(start.getAttribute("class")).toContain("state-observing");
    expect(start.querySelector("title")?.textContent).toContain("Waiting for the first step");
    expect(screen.getByText("Waiting for the first step")).toBeTruthy();
  });

  it("does not let unmapped activity finish it", () => {
    // The whole point: tool calls are not step announcements, however many.
    const { start } = draw([
      event("tool.start", "Read", "2026-08-29T10:00:05.000Z"),
      event("tool.start", "Bash", "2026-08-29T10:00:09.000Z"),
      event("turn.end", "Working on it", "2026-08-29T10:00:12.000Z"),
    ]);
    expect(start.getAttribute("class")).not.toContain("state-done");
  });

  it("finishes it once a step is announced", () => {
    const { start } = draw([event("tool.start", "Read", "2026-08-29T10:00:05.000Z"), marker()]);
    expect(start.getAttribute("class")).toContain("state-done");
  });

  it("still shows nothing at all before the first event", () => {
    const { start } = draw([]);
    expect(start.getAttribute("class")).toContain("state-queued");
  });

  it("stops claiming to be watching once the session is no longer being read", () => {
    for (const state of ["observation_lost", "ambiguous_match", "completed", "failed"] as const) {
      const { start, unmount } = draw([event("tool.start", "Read", "2026-08-29T10:00:05.000Z")], state);
      // No endless pulse on a session nobody is reading, and no green either:
      // Anthill never learned whether the workflow got past Start.
      expect(start.getAttribute("class")).toContain("state-unknown");
      expect(start.getAttribute("class")).not.toContain("moves");
      unmount();
    }
  });

  it("carries its meaning in words, not only in colour or motion", () => {
    const { start } = draw([event("tool.start", "Read", "2026-08-29T10:00:05.000Z")]);
    expect(start.querySelector("title")?.textContent).toBe("Start — Waiting for the first step");
  });
});

/**
 * One border on an active block.
 *
 * ANT-15. A live block used to gain a second rounded rect six pixels outside
 * its own, so the step being worked on sat visibly heavier than every other
 * block on the canvas — two outlines for one fact. The pulse now lives on the
 * border the block already had, which also means nothing around the block
 * moves: same size, same ports, same edges landing on them.
 */
describe("an active block's outline", () => {
  function drawRunning() {
    const events: ObservationEvent[] = [
      {
        runId: "ANT-1",
        seq: 1,
        at: "2026-08-29T10:00:05.000Z",
        recordedAt: "2026-08-29T10:00:05.000Z",
        cli: "claude-code",
        source: "transcript",
        channel: "claude-code:transcript",
        kind: "step.marker",
        title: "implement",
        blockId: "implement",
      },
    ];
    const view = foldLiveSession(workflow, run, events);
    render(
      <LiveWorkflowGraph
        workflow={workflow}
        view={view}
        sessionState="detected_live"
        onSelect={vi.fn()}
      />,
    );
    return [...document.querySelectorAll(".live-node")].find((el) =>
      el.getAttribute("class")?.includes("state-running"),
    ) as Element;
  }

  it("draws exactly one border, and it is the block's own", () => {
    const node = drawRunning();
    const outlined = [...node.querySelectorAll("rect")].filter((r) => r.getAttribute("stroke"));
    expect(outlined).toHaveLength(1);
    expect(outlined[0].getAttribute("class")).toBe("live-node-body");
  });

  it("keeps everything it draws inside the block it belongs to", () => {
    // The old ring sat six pixels outside on every side. Nothing may now.
    const node = drawRunning();
    const body = node.querySelector(".live-node-body") as SVGRectElement;
    const left = Number(body.getAttribute("x"));
    const top = Number(body.getAttribute("y"));
    const right = left + Number(body.getAttribute("width"));
    const bottom = top + Number(body.getAttribute("height"));

    for (const shape of node.querySelectorAll("rect")) {
      const x = Number(shape.getAttribute("x"));
      const y = Number(shape.getAttribute("y"));
      expect(x).toBeGreaterThanOrEqual(left);
      expect(y).toBeGreaterThanOrEqual(top);
      expect(x + Number(shape.getAttribute("width"))).toBeLessThanOrEqual(right);
      expect(y + Number(shape.getAttribute("height"))).toBeLessThanOrEqual(bottom);
    }
  });

  it("still says it is working, in a word and not only in motion", () => {
    const node = drawRunning();
    expect(node.querySelector("title")?.textContent).toContain("Working");
    // The on-card line now carries "· Ns so far" after the word — a ticking
    // elapsed since the step's own announcement, never a promised finish.
    const line = node.querySelector(".live-node-state");
    expect(line?.textContent).toContain("Working");
    expect(line?.textContent).toContain("so far");
  });

  it("leaves the blocks around it with one plain border each", () => {
    drawRunning();
    for (const node of document.querySelectorAll(".live-node")) {
      const outlined = [...node.querySelectorAll("rect")].filter((r) => r.getAttribute("stroke"));
      expect(outlined).toHaveLength(1);
    }
  });
});

/**
 * A branch that was not taken, drawn as though it had been (ANT-55).
 *
 * The edge tone used to be decided by the source alone: once a step finished,
 * every edge leaving it turned green. On a workflow that branches that is a
 * claim about a path control never went down — in the session this was reported
 * from, a green arrow ran into "Checkpoint, close and report" while the run was
 * still working two steps upstream, so the diagram announced a checkpoint that
 * had not been reached.
 *
 * The rework loop is here for the opposite reason: the fix must not be "colour
 * an edge whenever both ends have run", because a loop's back edge points at a
 * step that has already finished and would light up on the strength of that
 * first pass.
 */
describe("edges only carry control where control demonstrably went", () => {
  const branching: Workflow = {
    id: "workflow-2",
    name: "Select, run, checkpoint",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
      {
        id: "select",
        type: "agent",
        name: "Select one untested scenario",
        config: { actionKind: "agent-step", task: "Pick one" },
        position: { x: 300, y: 0 },
      },
      {
        id: "scenario",
        type: "agent",
        name: "Run the scenario",
        config: { actionKind: "agent-step", task: "Run it" },
        position: { x: 600, y: 0 },
      },
      {
        id: "record",
        type: "agent",
        name: "Record observations",
        config: { actionKind: "agent-step", task: "Write it down" },
        position: { x: 900, y: 0 },
      },
      {
        id: "checkpoint",
        type: "agent",
        name: "Checkpoint, close and report",
        config: { actionKind: "agent-step", task: "Hand off" },
        position: { x: 600, y: 300 },
      },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 1200, y: 0 } },
    ],
    edges: [
      { id: "to-select", source: "start", target: "select" },
      { id: "to-scenario", source: "select", target: "scenario" },
      { id: "to-checkpoint", source: "select", target: "checkpoint" },
      { id: "to-record", source: "scenario", target: "record" },
      { id: "back-to-select", source: "record", target: "select" },
      { id: "to-end", source: "checkpoint", target: "end" },
    ],
    metadata: { workflow: { formatVersion: 4 } },
  };

  let seq = 0;
  function announce(blockId: string, at: string): ObservationEvent {
    seq += 1;
    return {
      runId: "ANT-1",
      seq,
      at,
      recordedAt: at,
      cli: "claude-code",
      source: "transcript",
      channel: "claude-code:transcript",
      kind: "step.marker",
      title: blockId,
      blockId,
    };
  }

  function draw(events: ObservationEvent[]) {
    const view = foldLiveSession(branching, run, events);
    const { unmount } = render(
      <LiveWorkflowGraph
        workflow={branching}
        view={view}
        sessionState={run.state}
        onSelect={vi.fn()}
      />,
    );
    const tone = (id: string) =>
      (document.querySelector(`[data-edge="${id}"]`)?.getAttribute("class") ?? "")
        .replace("live-edge ", "");
    return { tone, unmount };
  }

  /** Announced select, then scenario: the run is working on the upper branch. */
  const workingUpstream = () => [
    announce("select", "2026-08-29T10:00:05.000Z"),
    announce("scenario", "2026-08-29T10:00:10.000Z"),
  ];

  it("leaves the branch control did not take grey", () => {
    const { tone, unmount } = draw(workingUpstream());
    expect(tone("to-checkpoint")).toBe("tone-idle");
    unmount();
  });

  it("still flows the branch control did take", () => {
    const { tone, unmount } = draw(workingUpstream());
    expect(tone("to-scenario")).toBe("tone-live");
    expect(tone("to-select")).toBe("tone-seen");
    unmount();
  });

  it("does not reach the end while a step is still working", () => {
    const { tone, unmount } = draw(workingUpstream());
    expect(tone("to-end")).toBe("tone-idle");
    unmount();
  });

  it("leaves a rework edge grey until the loop has actually come round", () => {
    const { tone, unmount } = draw([
      ...workingUpstream(),
      announce("record", "2026-08-29T10:00:20.000Z"),
    ]);
    expect(tone("to-record")).toBe("tone-live");
    expect(tone("back-to-select")).toBe("tone-idle");
    unmount();
  });

  /** Live, not merely seen: the loop has come round and that step is working. */
  it("flows the rework edge once the step is announced a second time", () => {
    const { tone, unmount } = draw([
      ...workingUpstream(),
      announce("record", "2026-08-29T10:00:20.000Z"),
      announce("select", "2026-08-29T10:00:30.000Z"),
    ]);
    expect(tone("back-to-select")).toBe("tone-live");
    unmount();
  });

  it("draws nothing at all before the first step is announced", () => {
    const { tone, unmount } = draw([]);
    for (const id of ["to-select", "to-scenario", "to-checkpoint", "to-record", "to-end"]) {
      expect(tone(id)).toBe("tone-idle");
    }
    unmount();
  });
});

/**
 * Two lines cannot both be bringing control here.
 *
 * Several connections arrive at one step, and once a loop has come round more
 * than one of them will have carried work at some point. The diagram drew every
 * one of them pulsing, so a checkpoint sat with two dashed blue lines
 * converging on it, each claiming to be delivering the work that moment
 * (ANT-53). Exactly one of them did it last.
 */
describe("only the connection that carried control last pulses", () => {
  const converging: Workflow = {
    id: "workflow-3",
    name: "Two ways in",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
      {
        id: "first",
        type: "agent",
        name: "Read-only readiness",
        config: { actionKind: "agent-step", task: "check" },
        position: { x: 300, y: 0 },
      },
      {
        id: "second",
        type: "agent",
        name: "Startup and isolation",
        config: { actionKind: "agent-step", task: "check" },
        position: { x: 600, y: 0 },
      },
      {
        id: "checkpoint",
        type: "agent",
        name: "Checkpoint, close and report",
        config: { actionKind: "agent-step", task: "hand off" },
        position: { x: 900, y: 300 },
      },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 1200, y: 300 } },
    ],
    edges: [
      { id: "in-first", source: "start", target: "first" },
      { id: "first-second", source: "first", target: "second" },
      { id: "first-checkpoint", source: "first", target: "checkpoint" },
      { id: "second-checkpoint", source: "second", target: "checkpoint" },
      { id: "checkpoint-end", source: "checkpoint", target: "end" },
    ],
    metadata: { workflow: { formatVersion: 4 } },
  };

  let seq = 0;
  function announce(blockId: string, at: string): ObservationEvent {
    seq += 1;
    return {
      runId: "ANT-1",
      seq,
      at,
      recordedAt: at,
      cli: "claude-code",
      source: "transcript",
      channel: "claude-code:transcript",
      kind: "step.marker",
      title: blockId,
      blockId,
    };
  }

  function draw(events: ObservationEvent[]) {
    const view = foldLiveSession(converging, run, events);
    const { unmount } = render(
      <LiveWorkflowGraph
        workflow={converging}
        view={view}
        sessionState={run.state}
        onSelect={vi.fn()}
      />,
    );
    const tone = (id: string) =>
      (document.querySelector(`[data-edge="${id}"]`)?.getAttribute("class") ?? "")
        .replace("live-edge ", "");
    const live = () =>
      [...document.querySelectorAll(".live-edge.tone-live")].length;
    return { tone, live, unmount };
  }

  /** first, then second, then back through first, then the checkpoint. */
  const both = () => [
    announce("first", "2026-08-29T10:00:05.000Z"),
    announce("second", "2026-08-29T10:00:10.000Z"),
    announce("first", "2026-08-29T10:00:20.000Z"),
    announce("checkpoint", "2026-08-29T10:00:30.000Z"),
  ];

  it("draws exactly one pulsing line into the step", () => {
    const { live, unmount } = draw(both());
    expect(live()).toBe(1);
    unmount();
  });

  it("picks the connection whose source was there most recently", () => {
    const { tone, unmount } = draw(both());
    expect(tone("first-checkpoint")).toBe("tone-live");
    unmount();
  });

  it("still shows the other as travelled, because it was — earlier", () => {
    const { tone, unmount } = draw(both());
    expect(tone("second-checkpoint")).toBe("tone-seen");
    unmount();
  });

  it("leaves a step nothing has reached with no line into it at all", () => {
    const { tone, unmount } = draw([announce("first", "2026-08-29T10:00:05.000Z")]);
    expect(tone("first-checkpoint")).toBe("tone-idle");
    expect(tone("second-checkpoint")).toBe("tone-idle");
    unmount();
  });
});
