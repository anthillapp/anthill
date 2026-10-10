/**
 * The Todo list tab (ANT-310): a subagent's own list, in its words, and a
 * plain statement when there is none.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockTodoList } from "@anthill/live";

import { TodoTab } from "./TodoTab.js";

afterEach(cleanup);

const list: BlockTodoList = {
  owner: "call-qa",
  ownerName: "general-purpose",
  pass: 1,
  updatedAt: "2026-10-10T14:26:20.000Z",
  items: [
    { id: "1", title: "Check the working tree is clean", status: "completed" },
    { id: "2", title: "Run the full test suite", status: "completed" },
    { id: "3", title: "Collect the names of failing tests", status: "in_progress" },
    { id: "4", title: "Re-run failures in isolation", status: "pending" },
    { id: "5", title: "Write the result summary", status: "pending" },
  ],
};

const nameOf = () => "Tester";

describe("the Todo list tab", () => {
  it("shows the list as the agent reported it while the step runs", () => {
    render(<TodoTab lists={[list]} state="running" passes={1} ended={false} agent="Tester" nameOf={nameOf} />);
    const panel = screen.getByRole("tabpanel", { name: "Todo list" });
    expect(within(panel).getByText("Reported by Tester")).toBeTruthy();
    expect(within(panel).getByText(/The agent's own list, in its own words/)).toBeTruthy();
    expect(within(panel).getByText("2 of 5")).toBeTruthy();
    expect(within(panel).getAllByRole("listitem").map((item) => item.querySelector(".todo-title")?.textContent)).toEqual(
      list.items.map((item) => item.title),
    );
    expect(within(panel).getByText("in progress")).toBeTruthy();
    expect(within(panel).queryByText("left open")).toBeNull();
    expect(within(panel).getByText(/^Last change /)).toBeTruthy();
  });

  it("calls what was not done left open once the step has ended", () => {
    render(<TodoTab lists={[list]} state="done" passes={1} ended={false} agent="Tester" nameOf={nameOf} />);
    expect(screen.getAllByText("left open")).toHaveLength(3);
    expect(screen.queryByText("in progress")).toBeNull();
    expect(screen.getByText(/^Final list · last change /)).toBeTruthy();
  });

  it("treats an ended session's running step as ended", () => {
    render(<TodoTab lists={[list]} state="running" passes={1} ended agent="Tester" nameOf={nameOf} />);
    expect(screen.queryByText("in progress")).toBeNull();
    expect(screen.getByText(/^Final list/)).toBeTruthy();
  });

  it("labels the pass when the step had more than one", () => {
    render(<TodoTab lists={[{ ...list, pass: 2 }]} state="running" passes={2} ended={false} agent="Tester" nameOf={nameOf} />);
    expect(screen.getByText("Reported by Tester · pass 2")).toBeTruthy();
  });

  it("shows one group per subagent", () => {
    render(
      <TodoTab
        lists={[list, { ...list, owner: "call-e2e" }]}
        state="running"
        passes={1}
        ended={false}
        agent="Tester"
        nameOf={(found) => (found.owner === "call-e2e" ? "E2E runner" : "Tester")}
      />,
    );
    expect(screen.getByText("Reported by Tester")).toBeTruthy();
    expect(screen.getByText("Reported by E2E runner")).toBeTruthy();
  });

  it("says no list was reported, and why, rather than inventing one", () => {
    const { unmount } = render(<TodoTab lists={undefined} state="queued" passes={0} ended={false} agent="Tester" nameOf={nameOf} />);
    expect(screen.getByText("No todo list reported")).toBeTruthy();
    expect(screen.getByText("This step hasn't started, so no agent has written a list for it yet.")).toBeTruthy();
    unmount();
    render(<TodoTab lists={[]} state="done" passes={1} ended={false} agent="Tester" nameOf={nameOf} />);
    expect(screen.getByText("Tester didn't keep a todo list in this step. Anthill only shows a list the agent reports itself.")).toBeTruthy();
  });
});
