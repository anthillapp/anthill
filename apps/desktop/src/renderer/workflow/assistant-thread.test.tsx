/**
 * Closing the panel is not forgetting the conversation.
 *
 * ANT-82 in one line: the thread was `useState` inside the assistant, so the ✕
 * unmounted the record along with the panel. The first test here is that bug,
 * stated as the thing that must now be true — close, reopen, and the
 * conversation is the one you left.
 *
 * The rest are the ways a fix like this quietly reintroduces the loss: writing
 * the panel's empty opening state over the record it is about to read, letting
 * a slow read for the workflow just left land in the one just opened, and —
 * worst, because it looks like it worked — turning "the record could not be
 * read" into "there is no record".
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTurns, useAssistantThread, type ChatTurn } from "./assistant-thread.js";

const proposal = {
  version: 1,
  summary: "Add a review step.",
  ops: [{ op: "connect", source: "a", target: "b" }],
};

/** A fake record, with the reads deferred so the ordering can be driven. */
function store(initial: Record<string, unknown[]> = {}) {
  const threads: Record<string, unknown[]> = { ...initial };
  const pending: { id: string; settle: () => void }[] = [];
  let fail = false;
  const assistantThreadWrite = vi.fn(async (id: string, turns: unknown[]) => {
    threads[id] = turns;
  });
  const assistantThreadClear = vi.fn(async (id: string) => {
    delete threads[id];
  });
  const assistantThreadRead = vi.fn(
    (id: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        pending.push({
          id,
          settle: () => (threads[id] === undefined && fail ? reject(new Error("unreadable")) : resolve(threads[id] ?? [])),
        });
      }),
  );
  (window as unknown as { anthill: unknown }).anthill = {
    assistantThreadRead,
    assistantThreadWrite,
    assistantThreadClear,
  };
  return {
    threads,
    assistantThreadRead,
    assistantThreadWrite,
    assistantThreadClear,
    failReads: () => (fail = true),
    /** Let the queued reads resolve, in the order they were made. */
    flush: async () => {
      const queued = pending.splice(0, pending.length);
      for (const item of queued) item.settle();
      await act(async () => undefined);
    },
    /** Let only the read at `index` resolve, to drive an out-of-order landing. */
    settle: async (index: number) => {
      const [item] = pending.splice(index, 1);
      item?.settle();
      await act(async () => undefined);
    },
  };
}

/** The panel, reduced to what this is about: a thread that is shown and added to. */
function Panel({ workflowId }: { workflowId: string }) {
  const { turns, setTurns, ready, clear } = useAssistantThread(workflowId);
  return (
    <div>
      <p data-testid="ready">{String(ready)}</p>
      <ul data-testid="thread">
        {turns.map((turn, at) => (
          <li key={at}>{turn.kind === "user" ? turn.text : turn.kind}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setTurns((current) => [...current, { kind: "user", text: "said", mentions: [] }])}
      >
        say
      </button>
      <button type="button" onClick={clear}>
        clear
      </button>
    </div>
  );
}

const shown = () => [...document.querySelectorAll("[data-testid=thread] li")].map((li) => li.textContent);

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the thread across the panel's life", () => {
  it("is the conversation you left when the panel is closed and reopened", async () => {
    const api = store({ "workflow-1": [{ kind: "user", text: "Add a review step", mentions: [] }] });

    const first = render(<Panel workflowId="workflow-1" />);
    await api.flush();
    expect(shown()).toEqual(["Add a review step"]);

    act(() => screen.getByText("say").click());
    await act(async () => undefined);
    expect(api.assistantThreadWrite).toHaveBeenCalledWith("workflow-1", [
      { kind: "user", text: "Add a review step", mentions: [] },
      { kind: "user", text: "said", mentions: [] },
    ]);

    // The ✕: the panel goes away entirely.
    first.unmount();

    render(<Panel workflowId="workflow-1" />);
    await api.flush();
    expect(shown()).toEqual(["Add a review step", "said"]);
  });

  it("never writes the panel's empty opening state over the record", async () => {
    // The whole failure mode of a fix like this: the panel mounts empty, and an
    // eager write stores that emptiness over the conversation it is loading.
    const api = store({ "workflow-1": [{ kind: "user", text: "Still here", mentions: [] }] });
    render(<Panel workflowId="workflow-1" />);
    expect(api.assistantThreadWrite).not.toHaveBeenCalled();
    await api.flush();
    expect(api.assistantThreadWrite).not.toHaveBeenCalled();
    expect(shown()).toEqual(["Still here"]);
  });

  it("keeps each workflow's conversation to itself", async () => {
    const api = store({
      "workflow-1": [{ kind: "user", text: "About one", mentions: [] }],
      "workflow-2": [{ kind: "user", text: "About two", mentions: [] }],
    });

    const view = render(<Panel workflowId="workflow-1" />);
    await api.flush();
    expect(shown()).toEqual(["About one"]);

    view.rerender(<Panel workflowId="workflow-2" />);
    await api.flush();
    expect(shown()).toEqual(["About two"]);

    view.rerender(<Panel workflowId="workflow-1" />);
    await api.flush();
    expect(shown()).toEqual(["About one"]);
    // Nothing was written on the way through: switching is reading, not saying.
    expect(api.assistantThreadWrite).not.toHaveBeenCalled();
  });

  it("drops a read that arrives after the workflow has moved on", async () => {
    const api = store({
      "workflow-1": [{ kind: "user", text: "About one", mentions: [] }],
      "workflow-2": [{ kind: "user", text: "About two", mentions: [] }],
    });

    const view = render(<Panel workflowId="workflow-1" />);
    view.rerender(<Panel workflowId="workflow-2" />);
    // The first workflow's read lands last. It must not be shown, and it must
    // not become the thing the second workflow writes back.
    await api.settle(1);
    await api.settle(0);
    expect(shown()).toEqual(["About two"]);
  });

  it("does not write when the record could not be read", async () => {
    // "Could not read the conversation" must never become "there is no
    // conversation" — which is exactly what writing an empty thread would do.
    const api = store();
    api.failReads();
    render(<Panel workflowId="workflow-1" />);
    await api.flush();

    act(() => screen.getByText("say").click());
    await act(async () => undefined);
    expect(api.assistantThreadWrite).not.toHaveBeenCalled();
    // The panel still works; the conversation just lasts as long as it is open.
    expect(shown()).toEqual(["said"]);
  });

  it("works with no record at all behind it", async () => {
    // An older main process has no such channel. The assistant opens anyway.
    (window as unknown as { anthill: unknown }).anthill = {};
    render(<Panel workflowId="workflow-1" />);
    await act(async () => undefined);
    expect(screen.getByTestId("ready").textContent).toBe("true");
    act(() => screen.getByText("say").click());
    await act(async () => undefined);
    expect(shown()).toEqual(["said"]);
  });

  it("forgets a thread only when told to, and only that one", async () => {
    const api = store({
      "workflow-1": [{ kind: "user", text: "Goes", mentions: [] }],
      "workflow-2": [{ kind: "user", text: "Stays", mentions: [] }],
    });
    render(<Panel workflowId="workflow-1" />);
    await api.flush();

    act(() => screen.getByText("clear").click());
    await act(async () => undefined);
    expect(api.assistantThreadClear).toHaveBeenCalledWith("workflow-1");
    expect(shown()).toEqual([]);
    expect(api.threads["workflow-2"]).toBeTruthy();
  });
});

describe("reading a stored turn", () => {
  it("keeps every state a proposal can have been left in", () => {
    const stored = [
      { kind: "proposal", summary: "Pending", changes: [], proposal },
      { kind: "proposal", summary: "Applied", changes: [], proposal, resolved: "applied" },
      { kind: "proposal", summary: "Discarded", changes: [], proposal, resolved: "discarded" },
      { kind: "proposal", summary: "Refused", changes: [], proposal, error: "No such block." },
    ];
    const turns = readTurns(stored) as Extract<ChatTurn, { kind: "proposal" }>[];
    expect(turns).toHaveLength(4);
    expect(turns.map((turn) => turn.resolved)).toEqual([undefined, "applied", "discarded", undefined]);
    expect(turns[3].error).toBe("No such block.");
    // Restoring shows; it never applies. The operations are all that is kept.
    expect(turns[0].proposal.ops).toEqual(proposal.ops);
  });

  it("drops the turns it cannot read and keeps the conversation", () => {
    const turns = readTurns([
      { kind: "user", text: "One", mentions: [] },
      { kind: "user" },
      { kind: "from-a-later-anthill", text: "?" },
      { kind: "proposal", summary: "Broken", proposal: { version: 99, ops: [] } },
      "not a turn",
      { kind: "user", text: "Two", mentions: ["block-1"] },
    ]);
    expect(turns).toEqual([
      { kind: "user", text: "One", mentions: [] },
      { kind: "user", text: "Two", mentions: ["block-1"] },
    ]);
  });

  it("refuses a proposal the applier could not honour", () => {
    // The same parser the live path uses, so there is one definition of what a
    // valid proposal is rather than two that can disagree.
    expect(readTurns([{ kind: "proposal", summary: "No ops list", proposal: { version: 1, summary: "x" } }])).toEqual(
      [],
    );
  });

  it("is an empty thread when the record is not a list", () => {
    expect(readTurns(undefined)).toEqual([]);
    expect(readTurns({ turns: [] })).toEqual([]);
  });
});
