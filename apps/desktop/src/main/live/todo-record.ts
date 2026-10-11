/**
 * An agent's own todo list, read out of its tool calls (ANT-310).
 *
 * Claude Code keeps one with `TaskCreate`/`TaskUpdate` (and, in older
 * versions, `TodoWrite`); Codex with `update_plan`. Anthill shows that list as
 * the agent reported it, so two rules hold here:
 *
 * - **Confirmed only.** A call is a request. The list changes when the tool
 *   says it did — a successful result — and a refused or unanswered call
 *   leaves the list as it was. Reading the call alone drew a rejected
 *   "completed" as done.
 * - **The title and nothing else.** An item's title is the agent's own
 *   prose, so it is redacted and cut short like every other value Anthill
 *   keeps. Descriptions, active forms and plan explanations are never read.
 */

import type { TodoChange, TodoItem, TodoStatus } from "@anthill/live";

import { redactSecrets } from "./redact.js";

/** How much of an item's title is kept. */
export const TODO_TITLE_MAX = 120;

/** How many items of one list are kept. */
export const TODO_ITEMS_MAX = 30;

/** The tools whose results change a Claude Code todo list. */
export const CLAUDE_TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TodoWrite"]);

/** What is kept of a todo call until its result says how it went. */
export type PendingTodoCall = {
  tool: string;
  /** The task a `TaskUpdate`/`TaskGet` names. */
  taskId?: string;
  /** The title a `TaskCreate` or a `TaskUpdate` gives. */
  subject?: string;
  /** The status a `TaskUpdate` asks for. */
  status?: TodoStatus | "deleted";
  /** A `TodoWrite` list, already cut down to titles and statuses. */
  items?: TodoItem[];
};

/** A title as Anthill keeps it, or nothing when there is no title. */
export function todoTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const redacted = redactSecrets(flat);
  return redacted.length > TODO_TITLE_MAX ? `${redacted.slice(0, TODO_TITLE_MAX)}…` : redacted;
}

function status(value: unknown): TodoStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
}

function taskId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^[\w.-]{1,40}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a todo call's card is named by: the task, never the task's
 * description, which is the agent's prose and is not kept. Nothing for any
 * other tool.
 */
export function todoCallTarget(name: string | undefined, input: Record<string, unknown>): string | undefined {
  if (name === "TaskCreate") return todoTitle(input.subject);
  if (name === "TaskUpdate" || name === "TaskGet") {
    const id = taskId(input.taskId);
    const wanted = typeof input.status === "string" ? input.status.replace("_", " ") : undefined;
    return id ? `#${id}${wanted ? ` → ${wanted}` : ""}` : undefined;
  }
  if (name === "TodoWrite") {
    return Array.isArray(input.todos) ? `${input.todos.length} ${input.todos.length === 1 ? "item" : "items"}` : undefined;
  }
  return undefined;
}

/** A whole list — `TodoWrite`'s `todos`, `update_plan`'s `plan`, a `TaskList` — cut to what is kept. */
export function todoList(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const title = todoTitle(entry.content ?? entry.step ?? entry.subject ?? entry.title);
    const state = status(entry.status);
    if (!title || !state) continue;
    const id = taskId(entry.id);
    items.push({ ...(id ? { id } : {}), title, status: state });
    if (items.length >= TODO_ITEMS_MAX) break;
  }
  return items;
}

/** What to keep of a Claude Code todo call, until its result arrives. */
export function claudeTodoCall(tool: string, input: Record<string, unknown>): PendingTodoCall | undefined {
  if (!CLAUDE_TODO_TOOLS.has(tool)) return undefined;
  if (tool === "TodoWrite") {
    const items = todoList(input.todos);
    return items ? { tool, items } : undefined;
  }
  const id = taskId(input.taskId);
  const subject = todoTitle(input.subject);
  const wanted = input.status === "deleted" ? "deleted" : status(input.status);
  return { tool, ...(id ? { taskId: id } : {}), ...(subject ? { subject } : {}), ...(wanted ? { status: wanted } : {}) };
}

/**
 * The change a Claude Code todo call made, read from its successful result.
 *
 * The result's structured record (`toolUseResult`) is read first; its text,
 * in Claude Code's own fixed wording, when the record has none. Anything else
 * — another wording, an id that does not match — is no confirmed change.
 */
export function claudeTodoChange(call: PendingTodoCall, record: unknown, text: string): TodoChange | undefined {
  const result = isRecord(record) ? record : undefined;
  const said = text.trim();

  if (call.tool === "TodoWrite") return call.items ? { op: "replace", items: call.items } : undefined;

  if (call.tool === "TaskList") {
    const tasks = result && Array.isArray(result.tasks) ? todoList(result.tasks) : undefined;
    return tasks ? { op: "replace", items: tasks } : undefined;
  }

  if (call.tool === "TaskCreate") {
    const task = result && isRecord(result.task) ? result.task : undefined;
    const fromRecord = task ? taskId(task.id) : undefined;
    const fromText = /^Task #([\w.-]+) created successfully: /.exec(said)?.[1];
    const id = fromRecord ?? fromText;
    const title = todoTitle(task?.subject) ?? call.subject;
    return id && title ? { op: "upsert", id, title, status: "pending" } : undefined;
  }

  if (call.tool === "TaskUpdate") {
    if (result && result.success === false) return undefined;
    const recorded = result ? taskId(result.taskId) : undefined;
    const fields = result && Array.isArray(result.updatedFields)
      ? result.updatedFields.filter((field): field is string => typeof field === "string")
      : undefined;
    const match = /^Updated task #([\w.-]+) ([\w, ]+)$/.exec(said);
    const id = recorded ?? match?.[1];
    const changed = fields ?? match?.[2]?.split(",").map((field) => field.trim());
    if (!id || !changed || (call.taskId && id !== call.taskId)) return undefined;
    const change = result && isRecord(result.statusChange) ? result.statusChange : undefined;
    const to = change?.to === "deleted" ? "deleted" : status(change?.to);
    const next = changed.includes("status") ? (to ?? call.status) : undefined;
    const title = changed.includes("subject") ? call.subject : undefined;
    if (!next && !title) return undefined;
    return { op: "upsert", id, ...(title ? { title } : {}), ...(next ? { status: next } : {}) };
  }

  if (call.tool === "TaskGet") {
    const task = result && isRecord(result.task) ? result.task : undefined;
    const id = task ? taskId(task.id) : undefined;
    const state = task ? status(task.status) : undefined;
    if (!id || !state || (call.taskId && id !== call.taskId)) return undefined;
    const title = todoTitle(task?.subject);
    return { op: "upsert", id, ...(title ? { title } : {}), status: state };
  }
  return undefined;
}

/**
 * The list a Codex `update_plan` call sets, once its output says it was set.
 *
 * Codex answers a plan it accepted with "Plan updated"; anything else is a
 * plan it did not take.
 */
export function codexPlanCall(argumentsValue: unknown): TodoItem[] | undefined {
  let args: unknown = argumentsValue;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  return isRecord(args) ? todoList(args.plan) : undefined;
}

export function codexPlanAccepted(output: string): boolean {
  return output.trim().startsWith("Plan updated");
}
