/**
 * What counts as a change to an agent's todo list (ANT-310): only what the
 * tool confirmed, and only the title of each item.
 */

import { describe, expect, it } from "vitest";

import {
  TODO_ITEMS_MAX,
  TODO_TITLE_MAX,
  claudeTodoCall,
  claudeTodoChange,
  codexPlanAccepted,
  codexPlanCall,
  todoCallTarget,
} from "./todo-record.js";

describe("Claude Code's task tools", () => {
  it("takes a created task's id from the structured result, and its title", () => {
    const call = claudeTodoCall("TaskCreate", { subject: "Run the suite", description: "Every test, with the names of failures" });
    expect(call).toEqual({ tool: "TaskCreate", subject: "Run the suite" });
    // Exactly what Claude Code writes, from a real transcript.
    const change = claudeTodoChange(call!, { task: { id: "1", subject: "Run the suite" } }, "Task #1 created successfully: Run the suite");
    expect(change).toEqual({ op: "upsert", id: "1", title: "Run the suite", status: "pending" });
  });

  it("falls back to Claude Code's own wording when the record has no structure", () => {
    const call = claudeTodoCall("TaskCreate", { subject: "Write the summary" })!;
    expect(claudeTodoChange(call, undefined, "Task #12 created successfully: Write the summary")).toEqual({
      op: "upsert",
      id: "12",
      title: "Write the summary",
      status: "pending",
    });
    expect(claudeTodoChange(call, undefined, "Something else entirely")).toBeUndefined();
  });

  it("reads an update's status from what it says changed", () => {
    const call = claudeTodoCall("TaskUpdate", { taskId: "1", status: "in_progress" })!;
    expect(
      claudeTodoChange(
        call,
        { success: true, taskId: "1", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } },
        "Updated task #1 status",
      ),
    ).toEqual({ op: "upsert", id: "1", status: "in_progress" });
    expect(claudeTodoChange(claudeTodoCall("TaskUpdate", { taskId: "1", status: "completed" })!, undefined, "Updated task #1 status")).toEqual({
      op: "upsert",
      id: "1",
      status: "completed",
    });
  });

  it("refuses an update whose result names another task, or says it failed", () => {
    const call = claudeTodoCall("TaskUpdate", { taskId: "1", status: "completed" })!;
    expect(claudeTodoChange(call, undefined, "Updated task #2 status")).toBeUndefined();
    expect(claudeTodoChange(call, { success: false, taskId: "1", updatedFields: [] }, "")).toBeUndefined();
    // An update that changed something other than status or title says nothing to show.
    expect(claudeTodoChange(call, undefined, "Updated task #1 description")).toBeUndefined();
  });

  it("takes a deleted task off the list", () => {
    const call = claudeTodoCall("TaskUpdate", { taskId: "3", status: "deleted" })!;
    expect(claudeTodoChange(call, undefined, "Updated task #3 status")).toEqual({ op: "upsert", id: "3", status: "deleted" });
  });

  it("replaces the list with a TodoWrite's, keeping only titles and statuses", () => {
    const call = claudeTodoCall("TodoWrite", {
      todos: [
        { content: "Read the spec", status: "completed", activeForm: "Reading the spec" },
        { content: "Implement", status: "in_progress", activeForm: "Implementing" },
        { content: "No status" },
      ],
    })!;
    const change = claudeTodoChange(call, undefined, "Todos have been modified successfully.");
    expect(change).toEqual({
      op: "replace",
      items: [
        { title: "Read the spec", status: "completed" },
        { title: "Implement", status: "in_progress" },
      ],
    });
    expect(JSON.stringify(change)).not.toContain("Reading the spec");
  });

  it("redacts a title and cuts it short, and keeps a bounded list", () => {
    const call = claudeTodoCall("TaskCreate", { subject: `Use API_KEY=sk-abcdefghijklmnopqrstuv ${"x".repeat(300)}` })!;
    expect(call.subject).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(call.subject!.length).toBeLessThanOrEqual(TODO_TITLE_MAX + 1);
    const many = claudeTodoCall("TodoWrite", {
      todos: Array.from({ length: 50 }, (_, index) => ({ content: `Item ${index}`, status: "pending" })),
    })!;
    expect(many.items).toHaveLength(TODO_ITEMS_MAX);
  });

  it("ignores every other tool", () => {
    expect(claudeTodoCall("Bash", { command: "ls" })).toBeUndefined();
    expect(todoCallTarget("Bash", { description: "List files" })).toBeUndefined();
  });

  it("names a todo call's card by its task, never by the task's description", () => {
    expect(todoCallTarget("TaskCreate", { subject: "Run the suite", description: "PRIVATE" })).toBe("Run the suite");
    expect(todoCallTarget("TaskUpdate", { taskId: "1", status: "in_progress" })).toBe("#1 → in progress");
    expect(todoCallTarget("TodoWrite", { todos: [{}, {}] })).toBe("2 items");
  });
});

describe("Codex's update_plan", () => {
  it("reads the plan's steps and statuses, never its explanation", () => {
    const plan = codexPlanCall(
      JSON.stringify({
        explanation: "Why this order",
        plan: [
          { step: "Create tailored CV copy", status: "completed" },
          { step: "Apply wording", status: "in_progress" },
        ],
      }),
    );
    expect(plan).toEqual([
      { title: "Create tailored CV copy", status: "completed" },
      { title: "Apply wording", status: "in_progress" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("Why this order");
  });

  it("counts a plan only when Codex says it took it", () => {
    expect(codexPlanAccepted("Plan updated")).toBe(true);
    expect(codexPlanAccepted("failed to parse function arguments: missing field `plan`")).toBe(false);
  });
});
