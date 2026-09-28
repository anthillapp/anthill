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

import { LiveWorkflowGraph, ZOOM_MAX, ZOOM_MIN, wasDrag } from "./LiveWorkflowGraph.js";

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

function show(selectedBlockId?: string) {
  const onSelect = vi.fn();
  const view = foldLiveSession(workflow, run, []);
  render(
    <LiveWorkflowGraph
      workflow={workflow}
      view={view}
      sessionState={run.state}
      selectedBlockId={selectedBlockId}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

/**
 * The pan guard, which the component cannot be asked about.
 *
 * A pan ends with a click on the background, and a click on the background
 * puts the selected step down — so dragging the diagram sideways while reading
 * a step must not close what you are reading. jsdom's pointer events carry no
 * clientX or clientY (both arrive as null), so the drag itself cannot be
 * simulated here; the rule is tested where it lives instead.
 */
describe("telling a pan from a click", () => {
  it("counts real travel as a drag", () => {
    expect(wasDrag({ x: 100, y: 100 }, { x: 260, y: 140 })).toBe(true);
  });

  it("lets a hand resting on the trackpad still be a click", () => {
    expect(wasDrag({ x: 100, y: 100 }, { x: 101, y: 102 })).toBe(false);
    expect(wasDrag({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
  });

  it("measures both directions, so a diagonal nudge is not a drag twice over", () => {
    expect(wasDrag({ x: 100, y: 100 }, { x: 97, y: 98 })).toBe(true);
    expect(wasDrag({ x: 100, y: 100 }, { x: 98, y: 99 })).toBe(false);
  });
});

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

  it("puts the step down when the click lands on the empty diagram", () => {
    // The ✕ on the activity filter was the only way back, across the window
    // from where the reader was looking.
    const { onSelect } = show("implement");
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(graph);
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it("puts it down for a click on a connection too – nothing there is selectable", () => {
    const { onSelect } = show("implement");
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(graph.querySelector(".live-edge") as Element);
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it("says nothing when there was no selection to put down", () => {
    const { onSelect } = show();
    fireEvent.click(document.querySelector(".live-graph") as unknown as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the step while a click lands on a block", () => {
    const { onSelect } = show("implement");
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(within(graph).getByText("Make the change"));
    // The block's own handler toggled it; the background must not fire as well.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it("selects when the click lands on the step's own words", () => {
    // The lines inside a block are laid out by the browser now, so a click
    // usually lands on the text rather than on the card behind it.
    const { onSelect } = show();
    const graph = document.querySelector(".live-graph") as unknown as HTMLElement;
    fireEvent.click(within(graph).getByText("Make the change"));
    expect(onSelect).toHaveBeenCalledWith("implement");
  });
});

/**
 * What a finished step says it cost.
 *
 * The running block already ticks; a done one had nothing to show for the time
 * it took, so the diagram forgot it the moment the next step started.
 */
describe("a finished step's elapsed time", () => {
  function draw(spentMs?: number) {
    const view = foldLiveSession(workflow, run, []);
    const shown = {
      ...view,
      blocks: {
        ...view.blocks,
        implement: {
          ...view.blocks.implement,
          state: "done" as const,
          passes: 1,
          ...(spentMs !== undefined ? { spentMs } : {}),
        },
      },
    };
    render(
      <LiveWorkflowGraph
        workflow={workflow}
        view={shown}
        sessionState={run.state}
        onSelect={vi.fn()}
      />,
    );
    return document.querySelector(".live-graph") as unknown as HTMLElement;
  }

  /** The state line of the step, which the End block also calls "Done". */
  const stateLine = (graph: HTMLElement) =>
    [...graph.querySelectorAll(".live-node-state")].map((line) => line.textContent);

  it("says how long it took, in the past tense", () => {
    // "so far" belongs to a step still going; this one has stopped.
    expect(stateLine(draw(4 * 60_000 + 30_000))).toContain("Done · took 4m 30s");
  });

  it("says only Done when the record could not measure it", () => {
    expect(stateLine(draw(undefined))).toContain("Done");
  });

  it("does not round a real measurement away to nothing", () => {
    expect(stateLine(draw(400))).toContain("Done · took 400ms");
  });
});

/*
  ANT-193. A session that finished on another branch left the step it skipped
  reading "Waiting its turn" under a "Session finished" header.
*/
describe("a step the session never reached", () => {
  function line(sessionState: PendingRun["state"]) {
    const view = foldLiveSession(workflow, { ...run, state: sessionState }, []);
    const { container, unmount } = render(
      <LiveWorkflowGraph workflow={workflow} view={view} sessionState={sessionState} onSelect={vi.fn()} />,
    );
    const text = container.querySelector(".live-node-state")?.textContent;
    unmount();
    return text;
  }

  it("waits its turn while the session is live", () => {
    expect(line("detected_live")).toBe("Waiting its turn");
  });

  it("was not reached once the session is over", () => {
    expect(line("completed")).toBe("Not reached");
    expect(line("failed")).toBe("Not reached");
  });

  it("may still get its turn when contact was only lost", () => {
    expect(line("observation_lost")).toBe("Waiting its turn");
  });
});

/**
 * A step's name cannot leave the card it is in.
 *
 * The name used to be cut at 24 characters, which is a guess at a width rather
 * than a measurement of one: "Этап 2 — локальное пони…" is 24 characters and
 * about 197 pixels in a box with room for 168, so it ran out through the
 * right-hand border — and took the group's bounding box with it, which is what
 * the platform's focus ring was drawn around.
 */
describe("a step whose name does not fit", () => {
  const long = "Этап 2 – локальное понимание экрана";

  function draw() {
    const renamed = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === "implement" ? { ...node, name: long } : node,
      ),
    };
    render(
      <LiveWorkflowGraph
        workflow={renamed}
        view={foldLiveSession(renamed, run, [])}
        sessionState={run.state}
        onSelect={vi.fn()}
      />,
    );
    return document.querySelector(".live-graph") as unknown as HTMLElement;
  }

  it("keeps the whole name, and lets the browser decide where it stops", () => {
    // Truncating in JavaScript is what got this wrong; the ellipsis belongs to
    // CSS, which knows the width the glyphs actually take.
    const graph = draw();
    expect(within(graph).getByText(long)).toBeTruthy();
  });

  it("holds every line inside the card", () => {
    const graph = draw();
    const name = within(graph).getByText(long);
    expect(name.closest("foreignObject")).toBeTruthy();
    // The rule that does the clipping, applied to each line rather than to the
    // box around them, so one long line cannot push the others out.
    expect(name.className).toContain("live-node-name");
    expect(name.parentElement?.className).toContain("live-node-lines");
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
/*
  W13 in the 0.8.3 QA: Review leads to Done when it approves and to "Stopped:
  report failure" when it fails. The session approved and finished, and both
  ends were drawn green — nothing it writes says which end it stopped at.
*/
describe("a workflow that can end in more than one place", () => {
  const twoEnds: Workflow = {
    ...workflow,
    nodes: [
      ...workflow.nodes,
      { id: "stopped", type: "end", name: "Stopped: report failure", config: {}, position: { x: 600, y: 200 } },
    ],
    edges: [...workflow.edges, { id: "e3", source: "implement", target: "stopped", kind: "stop" }],
  };

  function ends(shape: Workflow) {
    const finishedRun = { ...run, state: "completed" as const };
    const view = foldLiveSession(shape, finishedRun, []);
    const shown = {
      ...view,
      empty: false,
      blocks: { ...view.blocks, implement: { ...view.blocks.implement, state: "done" as const, passes: 1 } },
    };
    const { unmount } = render(
      <LiveWorkflowGraph workflow={shape} view={shown} sessionState="completed" onSelect={vi.fn()} />,
    );
    const classes = [...document.querySelectorAll(".live-node")]
      .filter((el) => /^(Done|Stopped)/.test(el.querySelector("title")?.textContent ?? ""))
      .map((el) => el.getAttribute("class") ?? "");
    unmount();
    return classes;
  }

  it("claims neither end when the record cannot say which was reached", () => {
    expect(ends(twoEnds).some((cls) => cls.includes("state-done"))).toBe(false);
  });

  it("still claims the one end a workflow has", () => {
    expect(ends(workflow).some((cls) => cls.includes("state-done"))).toBe(true);
  });
});

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
    expect(start.querySelector("title")?.textContent).toBe("Start – Waiting for the first step");
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
      // A choice, not a fork: one untested scenario is run, or there is none
      // and the loop ends. Without a condition the two would run side by side
      // (ANT-166).
      { id: "to-scenario", source: "select", target: "scenario", condition: "an untested scenario is left" },
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
    const view = foldLiveSession(branching, run, withWork(events));
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

  /*
    A move the workflow has no connection for is drawn as what it is: a trail
    the agent left, over the plan rather than in it. A rework loop the author
    drew is a connection, and it is the connection that lights up.
  */
  describe("a move the workflow never drew", () => {
    it("draws a trail from where the agent was to where it went", () => {
      const { unmount } = draw([
        ...workingUpstream(),
        announce("checkpoint", "2026-08-29T10:00:20.000Z"),
      ]);
      const trail = document.querySelector('.live-detour[data-from="scenario"][data-to="checkpoint"]');
      expect(trail).not.toBeNull();
      expect(trail?.textContent).toContain("on its own");
      unmount();
    });

    it("keeps the trail walking while the agent is still in that step", () => {
      const { unmount } = draw([
        ...workingUpstream(),
        announce("checkpoint", "2026-08-29T10:00:20.000Z"),
      ]);
      expect(document.querySelector(".live-detour.is-live")).not.toBeNull();
      unmount();
    });

    it("lets the trail rest once the agent has moved on along the plan", () => {
      const { unmount } = draw([
        ...workingUpstream(),
        // scenario → select: nothing drawn that way. Then select → scenario,
        // which the workflow has.
        announce("select", "2026-08-29T10:00:20.000Z"),
        announce("scenario", "2026-08-29T10:00:30.000Z"),
      ]);
      expect(document.querySelectorAll(".live-detour")).toHaveLength(1);
      expect(document.querySelector(".live-detour.is-live")).toBeNull();
      unmount();
    });

    it("draws no trail for a rework loop the workflow has", () => {
      const { unmount } = draw([
        ...workingUpstream(),
        announce("record", "2026-08-29T10:00:20.000Z"),
        announce("select", "2026-08-29T10:00:30.000Z"),
      ]);
      expect(document.querySelector(".live-detour")).toBeNull();
      unmount();
    });
  });

  /*
    ANT-170. A run that ended cleanly without taking a branch — no scenario
    left, straight to the checkpoint — never reached Done on the diagram,
    because the branch's steps stayed unreached and "every step done" was
    the only way there.
  */
  it("reaches Done along the step that led there when the session ended with a branch not taken", () => {
    const ended = { ...run, state: "completed" as const };
    const view = foldLiveSession(branching, ended, withWork([
      announce("select", "2026-08-29T10:00:05.000Z"),
      announce("checkpoint", "2026-08-29T10:00:10.000Z"),
    ]));
    const { unmount } = render(<LiveWorkflowGraph workflow={branching} view={view} sessionState="completed" onSelect={vi.fn()} />);
    const tone = (id: string) => document.querySelector(`[data-edge="${id}"]`)?.getAttribute("class") ?? "";
    expect(tone("to-end")).toContain("tone-seen");
    expect(tone("to-scenario")).toContain("tone-idle");
    const end = [...document.querySelectorAll("g.live-node")].find((node) =>
      node.querySelector("title")?.textContent?.startsWith("Done –"),
    );
    expect(end?.getAttribute("class")).toContain("state-done");
    unmount();
  });

  it("does not reach Done while the session is still going, whatever is finished", () => {
    const view = foldLiveSession(branching, run, withWork([
      announce("select", "2026-08-29T10:00:05.000Z"),
      announce("checkpoint", "2026-08-29T10:00:10.000Z"),
    ]));
    const { unmount } = render(<LiveWorkflowGraph workflow={branching} view={view} sessionState="detected_live" onSelect={vi.fn()} />);
    expect(document.querySelector(`[data-edge="to-end"]`)?.getAttribute("class") ?? "").toContain("tone-idle");
    unmount();
  });

  /*
    ANT-174. A loop enters its steps again, and the connection that started
    the loop went grey the moment it came round, though it was exactly the
    move that happened.
  */
  it("keeps a connection a loop took coloured after the loop comes round", () => {
    const { tone, unmount } = draw([
      ...workingUpstream(),
      announce("record", "2026-08-29T10:00:20.000Z"),
      announce("select", "2026-08-29T10:00:30.000Z"),
      announce("checkpoint", "2026-08-29T10:00:40.000Z"),
    ]);
    // select → scenario was taken on the first pass, before select ran again.
    expect(tone("to-scenario")).toBe("tone-seen");
    expect(tone("to-record")).toBe("tone-seen");
    expect(tone("back-to-select")).toBe("tone-seen");
    expect(tone("to-checkpoint")).toBe("tone-live");
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
    const view = foldLiveSession(converging, run, withWork(events));
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

  it("still shows the other as travelled, because it was – earlier", () => {
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

/**
 * Some work after each step line, as a real session does. A step left with
 * nothing done in it waits to see whether it was a fan-out (ANT-164); these
 * tests are about steps the agent worked through one after another.
 */
function withWork(events: ObservationEvent[]): ObservationEvent[] {
  return events.flatMap((event) => {
    if (event.kind !== "step.marker") return [event];
    const { blockId: _step, ...rest } = event;
    const work: ObservationEvent = {
      ...rest,
      kind: "tool.start",
      title: "Bash",
      toolUseId: `work-${event.seq}-${event.at}`,
      at: new Date(Date.parse(event.at) + 1).toISOString(),
    };
    return [event, work];
  });
}

/*
  ANT-166. Where parallel branches meet, control arrives along every branch
  and the step starts only once all have — so every branch's connection into
  it pulses, not just the last one to arrive.
*/
describe("where parallel branches meet", () => {
  const joining: Workflow = {
    id: "workflow-join",
    name: "Two services in parallel",
    version: "1",
    target: "claude-code",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 180 } },
      { id: "svc-a", type: "agent", name: "Change service A", config: { actionKind: "agent-step", task: "a" }, position: { x: 260, y: 60 } },
      { id: "svc-b", type: "agent", name: "Change service B", config: { actionKind: "agent-step", task: "b" }, position: { x: 260, y: 300 } },
      { id: "test", type: "agent", name: "Run tests", config: { actionKind: "agent-step", task: "t" }, position: { x: 540, y: 180 } },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 820, y: 180 } },
    ],
    edges: [
      { id: "to-a", source: "start", target: "svc-a" },
      { id: "to-b", source: "start", target: "svc-b" },
      { id: "a-test", source: "svc-a", target: "test" },
      { id: "b-test", source: "svc-b", target: "test" },
      { id: "test-end", source: "test", target: "end" },
    ],
    metadata: { workflow: { formatVersion: 4 } },
  };
  let seq = 0;
  const announce = (blockId: string, at: string): ObservationEvent => {
    seq += 1;
    return { runId: "ANT-1", seq, at, recordedAt: at, cli: "claude-code", source: "transcript", channel: "claude-code:transcript", kind: "step.marker", title: blockId, blockId };
  };

  it("pulses both branches into the step they meet at", () => {
    const view = foldLiveSession(joining, run, withWork([
      announce("svc-a", "2026-08-29T10:00:05.000Z"),
      announce("svc-b", "2026-08-29T10:00:10.000Z"),
      announce("test", "2026-08-29T10:00:20.000Z"),
    ]));
    render(<LiveWorkflowGraph workflow={joining} view={view} sessionState={run.state} onSelect={vi.fn()} />);
    const tone = (id: string) => document.querySelector(`[data-edge="${id}"]`)?.getAttribute("class") ?? "";
    expect(tone("a-test")).toContain("tone-live");
    expect(tone("b-test")).toContain("tone-live");
  });
});
