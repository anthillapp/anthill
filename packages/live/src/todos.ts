/**
 * The todo lists subagents kept, per step (ANT-310).
 *
 * A subagent's list is the agent's own statement of what it set out to do and
 * where it is — reported, never inferred. Only the changes its tool confirmed
 * reach the journal, so a "completed" the tool refused is never here.
 *
 * A list belongs to the subagent that kept it, not to the step: two subagents
 * at work on one step keep two lists. And a subagent reused for another step
 * keeps its list going, so each step shows the list as it stood the last time
 * that subagent changed it while working there.
 *
 * Nothing here touches a step's state. A step whose every item is ticked is
 * not done because of it, and one whose list changes is not reopened.
 */

import type { BlockSpanView } from "./live-session.js";
import type { AttributedEvent } from "./live-session.js";
import type { TodoItem } from "./observation-event.js";

/** One subagent's list as a step shows it. */
export type BlockTodoList = {
  /** The call that started the subagent: who kept the list. */
  owner: string;
  /** The subagent's name, when its own record gave one. */
  ownerName?: string;
  /** Which pass of the step the list's last change was made in. */
  pass?: number;
  items: TodoItem[];
  /** When the list last changed while the subagent worked for this step. */
  updatedAt: string;
};

/** How many items a list keeps. The rest of a runaway list is not the point. */
export const TODO_LIMIT = 30;

/**
 * Every step's subagent lists, by block id, each step's in the order its
 * subagents first changed them.
 *
 * Only a subagent's record counts: the session's own list is not any one
 * step's, and is not shown here. A change the fold could not tie to a step is
 * left out rather than pinned on whichever step happened to be running.
 */
export function blockTodos(
  events: readonly AttributedEvent[],
  spans: readonly BlockSpanView[],
): Record<string, BlockTodoList[]> {
  /** Each subagent's list, cumulative over everything it reported. */
  const lists = new Map<string, TodoItem[]>();
  const result: Record<string, BlockTodoList[]> = {};

  for (const event of events) {
    if (event.kind !== "todo" || !event.todo || !event.parentToolUseId) continue;
    const owner = event.parentToolUseId;
    const blockId = event.mapping.blockId;
    const change = event.todo;
    let items = lists.get(owner) ?? [];

    if (change.op === "replace") {
      items = change.items.slice(0, TODO_LIMIT).map((item) => ({ ...item }));
    } else {
      const at = items.findIndex((item) => item.id === change.id);
      const status = change.status === "deleted" ? undefined : change.status;
      if (change.status === "deleted") {
        if (at >= 0) items = items.filter((_, index) => index !== at);
      } else if (at >= 0) {
        const current = items[at] as TodoItem;
        items = items.map((item, index) =>
          index === at
            ? { ...current, ...(change.title ? { title: change.title } : {}), ...(status ? { status } : {}) }
            : item,
        );
      } else if (change.title && items.length < TODO_LIMIT) {
        // Only a task created with its title joins the list. An update for a
        // task the list never confirmed names nothing it could show.
        items = [...items, { id: change.id, title: change.title, status: status ?? "pending" }];
      }
    }
    lists.set(owner, items);

    if (!blockId) continue;
    const forBlock = (result[blockId] ??= []);
    const pass = passAt(spans, blockId, event.at);
    const name = event.author?.kind === "subagent" ? event.author.name : undefined;
    const entry: BlockTodoList = {
      owner,
      ...(name ? { ownerName: name } : {}),
      ...(pass !== undefined ? { pass } : {}),
      items: items.map((item) => ({ ...item })),
      updatedAt: event.at,
    };
    const existing = forBlock.findIndex((list) => list.owner === owner);
    if (existing >= 0) forBlock[existing] = entry;
    else forBlock.push(entry);
  }

  // A list emptied to nothing has nothing to show; the step says so instead.
  for (const [blockId, forBlock] of Object.entries(result)) {
    const kept = forBlock.filter((list) => list.items.length > 0);
    if (kept.length > 0) result[blockId] = kept;
    else delete result[blockId];
  }
  return result;
}

/** The pass of a step a moment falls in: the last pass begun at or before it. */
function passAt(spans: readonly BlockSpanView[], blockId: string, at: string): number | undefined {
  const moment = Date.parse(at);
  let pass: number | undefined;
  for (const span of spans) {
    if (span.blockId !== blockId) continue;
    if (Number.isNaN(moment) || Date.parse(span.startedAt) <= moment) pass = span.pass;
  }
  return pass;
}

/** How many of a list's items are done, and how many there are. */
export function todoProgress(items: readonly TodoItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === "completed").length, total: items.length };
}
