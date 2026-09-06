/**
 * The order of authority, and the thread that keeps it.
 *
 * The author describes, the interpreter proposes, Anthill previews — and
 * nothing becomes the workflow until the author applies it. Those cases came
 * from the modal this replaced and still hold.
 *
 * What ANT-37 adds is the thread. A proposal that was decided stays visible as
 * a record and loses only its buttons, so there is never more than one live
 * set of actions to press out of order; and mentions are ids, so pointing at a
 * block survives the block being renamed afterwards.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { DescribeChangeAssistant } from "./DescribeChangeAssistant.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement and check",
  version: "1",
  target: "claude-code",
  brief: { goal: "Make the change safely." },
  nodes: [
    { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "implement",
      type: "agent",
      name: "Implement",
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

const proposal = {
  version: 1,
  summary: "Add a review step between implement and done.",
  ops: [
    {
      op: "add-block",
      ref: "review",
      blockType: "agent",
      name: "Review the change",
      near: "implement",
      config: { actionKind: "llm-review", task: "Review it" },
    },
    { op: "disconnect", edgeId: "e2" },
    { op: "connect", source: "implement", target: "review" },
    { op: "connect", source: "review", target: "end" },
  ],
};

const reply = (body: unknown) => ({
  ok: true as const,
  reply: JSON.stringify(body),
  command: "claude …",
});

/** Replies in order; the last one repeats, so one draft covers a single ask. */
function stub(...drafts: unknown[]) {
  let at = 0;
  const draftFromPrompt = vi.fn(async () => drafts[Math.min(at++, drafts.length - 1)]);
  const cancelPromptDraft = vi.fn(async () => undefined);
  (window as unknown as { anthill: unknown }).anthill = {
    detectInterpreters: vi.fn(async () => [
      { id: "claude-code", label: "Claude Code", available: true },
    ]),
    draftFromPrompt,
    cancelPromptDraft,
  };
  return { draftFromPrompt, cancelPromptDraft };
}

/** Renders with mentions lifted, the way the screen owns them. */
function mount(over: Partial<Parameters<typeof DescribeChangeAssistant>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const onMentionsChange = vi.fn();
  const view = render(
    <DescribeChangeAssistant
      workflow={workflow}
      mentions={[]}
      onMentionsChange={onMentionsChange}
      onApply={onApply}
      onClose={onClose}
      {...over}
    />,
  );
  return { onApply, onClose, onMentionsChange, view };
}

async function ask(text = "Add a review step after implement.") {
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText(/Split this task/), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the order of authority", () => {
  it("shows the proposal without touching the workflow", async () => {
    const { draftFromPrompt } = stub(reply(proposal));
    const { onApply } = mount();
    await ask();

    await waitFor(() => expect(screen.getByText(/Add a review step between/)).toBeTruthy());
    const sent = (draftFromPrompt.mock.calls[0] as unknown[])[0] as { instruction: string };
    expect(sent.instruction).toContain("<<<EDIT_REQUEST");
    expect(screen.getByText("Add a block: Review the change")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("makes the destructive row the loud one", async () => {
    stub(reply(proposal));
    mount();
    await ask();
    await waitFor(() => expect(screen.getByText(/Remove the connection/)).toBeTruthy());
    expect(screen.getByText("Remove the connection implement → end").className).toContain(
      "is-destructive",
    );
  });

  it("applies only on the author's word, and hands over the new workflow", async () => {
    stub(reply(proposal));
    const { onApply, onClose } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const next = onApply.mock.calls[0][0] as Workflow;
    expect(next.nodes.some((node) => node.name === "Review the change")).toBe(true);
    expect(next.edges.some((edge) => edge.id === "e2")).toBe(false);
    // Applying does not close the assistant — the thread is the point of it.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a decline as the interpreter's own words, not an error", async () => {
    stub(reply({ version: 1, summary: "That is a task, not a graph edit.", ops: [] }));
    mount();
    await ask();
    await waitFor(() => expect(screen.getByText(/declined/)).toBeTruthy());
    expect(screen.getByText("That is a task, not a graph edit.")).toBeTruthy();
  });

  it("explains a malformed reply and leaves the workflow alone", async () => {
    stub({ ok: true, reply: "I went ahead and did the task!", command: "c" });
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByText(/No JSON object/)).toBeTruthy());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("explains a proposal that names a ghost, applying nothing", async () => {
    stub(
      reply({
        version: 1,
        summary: "Remove a block.",
        ops: [{ op: "remove-block", id: "does-not-exist" }],
      }),
    );
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByText(/does-not-exist/)).toBeTruthy());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("leaves no turn behind for a request the author took back", async () => {
    stub({ ok: false, cancelled: true, error: "cancelled" });
    mount();
    await ask();
    // The message is in the thread; nothing else is, because nothing happened.
    await waitFor(() => expect(screen.getByText(/Add a review step after implement/)).toBeTruthy());
    expect(screen.queryByText(/declined/)).toBeNull();
    expect(document.querySelector(".assistant-failed")).toBeNull();
  });
});

describe("the thread", () => {
  it("keeps every turn across requests in one session", async () => {
    stub(reply(proposal));
    mount();
    await ask("First request.");
    await waitFor(() => expect(screen.getByText(/Add a review step between/)).toBeTruthy());
    await ask("Second request.");

    await waitFor(() => expect(screen.getAllByText(/Add a review step between/)).toHaveLength(2));
    // Both of the author's own messages are still there.
    expect(screen.getByText("First request.")).toBeTruthy();
    expect(screen.getByText("Second request.")).toBeTruthy();
  });

  it("leaves only the newest proposal actionable", async () => {
    stub(reply(proposal));
    mount();
    await ask("First request.");
    await waitFor(() => expect(screen.getByText(/Add a review step between/)).toBeTruthy());
    await ask("Second request.");

    await waitFor(() => expect(screen.getAllByText(/Add a review step between/)).toHaveLength(2));
    // One Apply, not two — an older proposal cannot be pressed out of order.
    expect(screen.getAllByRole("button", { name: "Apply" })).toHaveLength(1);
    expect(screen.getByText("Discarded.")).toBeTruthy();
  });

  it("says what was decided, rather than removing the record", async () => {
    stub(reply(proposal));
    mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Applied to the canvas.")).toBeTruthy();
    // The diff itself is still readable; only the buttons are gone.
    expect(screen.getByText("Add a block: Review the change")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("discards without erasing", async () => {
    stub(reply(proposal));
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByText("Discarded.")).toBeTruthy();
    expect(screen.getByText("Add a block: Review the change")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("treats Adjust as continuing the same request, not deciding it", async () => {
    stub(reply(proposal));
    mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Adjust…" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Adjust…" }));

    // Still live, still undecided.
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.queryByText("Discarded.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Split this task/));
  });
});

describe("pointing at blocks instead of naming them", () => {
  it("shows a mention by the block's current name and can drop it", () => {
    stub(reply(proposal));
    const { onMentionsChange } = mount({ mentions: ["implement"] });
    expect(screen.getByText("Implement")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop referring to Implement/ }));
    expect(onMentionsChange).toHaveBeenCalledWith([]);
  });

  it("resolves a name as it is now, not as it was when clicked", () => {
    // Mentions travel as ids for exactly this reason.
    const renamed: Workflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === "implement" ? { ...node, name: "Write the change" } : node,
      ),
    };
    stub(reply(proposal));
    mount({ workflow: renamed, mentions: ["implement"] });
    expect(screen.getByText("Write the change")).toBeTruthy();
    expect(screen.queryByText("Implement")).toBeNull();
  });

  it("sends the mentioned ids to the interpreter and clears them", async () => {
    const { draftFromPrompt } = stub(reply(proposal));
    const { onMentionsChange } = mount({ mentions: ["implement"] });
    await ask("Split these.");

    const sent = (draftFromPrompt.mock.calls[0] as unknown[])[0] as { instruction: string };
    expect(sent.instruction).toContain("The author pointed at these blocks");
    expect(sent.instruction).toContain("implement (Implement)");
    // And the composer starts clean for the next message.
    expect(onMentionsChange).toHaveBeenCalledWith([]);
  });

  it("carries the mentions into the message they were sent with", async () => {
    stub(reply(proposal));
    mount({ mentions: ["implement"] });
    await ask("Split these.");
    const bubble = document.querySelector(".assistant-said");
    expect(bubble?.textContent).toContain("Implement");
    expect(bubble?.textContent).toContain("Split these.");
  });

  it("says how to reference a block at all", () => {
    stub(reply(proposal));
    mount();
    expect(screen.getByText("Click blocks on the canvas to reference them here.")).toBeTruthy();
  });
});

describe("while a request is out", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A draft that never settles, so the asking state can be looked at. */
  function pending() {
    (window as unknown as { anthill: unknown }).anthill = {
      detectInterpreters: vi.fn(async () => [
        { id: "claude-code", label: "Claude Code", available: true },
      ]),
      draftFromPrompt: vi.fn(() => new Promise(() => undefined)),
      cancelPromptDraft: vi.fn(async () => undefined),
    };
  }

  it("counts the seconds, because these take tens of them", async () => {
    pending();
    mount();
    await ask();
    await waitFor(() => expect(screen.getByText(/is reading the workflow/)).toBeTruthy());
    expect(screen.getByText(/\(0s\)/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/\(2s\)/)).toBeTruthy();
  });

  it("disables the composer and says the button is busy", async () => {
    pending();
    mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeTruthy());
    expect((screen.getByPlaceholderText(/Split this task/) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("offers to take the request back", async () => {
    pending();
    mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      (window as unknown as { anthill: { cancelPromptDraft: () => void } }).anthill
        .cancelPromptDraft,
    ).toHaveBeenCalled();
  });
});

/**
 * Any answer in the thread, not only the last one.
 *
 * ANT-38. After two more attempts the first answer may turn out to have been
 * the right one, so every proposal keeps its operations and can be applied.
 * What makes that safe is that the operations run against the graph as it is
 * *now*: an older proposal either still fits, or refuses whole and says why.
 * It can never quietly restore the workflow to the shape it had when the
 * proposal was made.
 */
describe("applying an earlier proposal", () => {
  it("offers it on a proposal that was already decided", async () => {
    stub(reply(proposal));
    mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Applied to the canvas.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply again" })).toBeTruthy();
  });

  it("applies the operations to the workflow as it is now", async () => {
    // The bug this replaced: the resulting workflow was computed when the
    // proposal arrived, so applying it later would hand back a graph built
    // before anything the author did since.
    stub(reply(proposal));
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const next = onApply.mock.calls[0][0] as Workflow;
    expect(next.nodes.some((node) => node.name === "Review the change")).toBe(true);
  });

  it("refuses whole, with the reason, when an old proposal no longer fits", async () => {
    stub(reply(proposal));
    const { view, onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    onApply.mockClear();

    // The block the proposal hangs its new step beside is gone now.
    const without: Workflow = {
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== "implement"),
      edges: [],
    };
    view.rerender(
      <DescribeChangeAssistant
        workflow={without}
        mentions={[]}
        onMentionsChange={vi.fn()}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply again" }));
    // Nothing was handed over, and the turn says which part no longer fits.
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector(".assistant-proposal-error")?.textContent).toContain(
      'no connection "e2"',
    );
  });

  it("says what it actually did, not what it would have done", async () => {
    // An older proposal re-applied to a changed graph can do something
    // different; the record is rewritten to what happened just now.
    stub(reply(proposal));
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Add a block: Review the change")).toBeTruthy();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("leaves an applied turn applied when it is applied again", async () => {
    stub(reply(proposal));
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply again" }));

    expect(onApply).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Applied to the canvas.")).toBeTruthy();
  });

  it("can apply a proposal that was discarded", async () => {
    stub(reply(proposal));
    const { onApply } = mount();
    await ask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    fireEvent.click(screen.getByRole("button", { name: "Apply again" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Applied to the canvas.")).toBeTruthy();
  });
});
