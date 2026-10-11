/**
 * The Todo list tab (ANT-310): the selected step's subagent lists, as the
 * agents reported them.
 *
 * Only what a subagent's own tool confirmed — Claude Code's `TaskCreate`,
 * `TaskUpdate`, `TodoWrite`; Codex's `update_plan` — and in its own order and
 * words. Anthill infers no list and draws no progress for a step without one;
 * it says plainly that none was reported.
 */

import { todoProgress, type BlockRunState, type BlockTodoList, type TodoItem } from "@anthill/live";

import { clock } from "./FeedCard.js";

export type TodoTabProps = {
  /** The step's lists, one per subagent that kept one. */
  lists: BlockTodoList[] | undefined;
  state: BlockRunState;
  /** How many passes the step has had, so a list can say which it is from. */
  passes: number;
  /** Whether the session is over. */
  ended: boolean;
  /** What the step's agent is called, for the empty state. */
  agent: string;
  /** What a list's subagent is called, by the call that started it. */
  nameOf: (list: BlockTodoList) => string;
};

/** Whether the step is still at work, which is when an item can be in progress. */
function stillRunning(state: BlockRunState, ended: boolean): boolean {
  return !ended && (state === "running" || state === "needsYou");
}

export function TodoTab({ lists, state, passes, ended, agent, nameOf }: TodoTabProps) {
  if (!lists || lists.length === 0) {
    return (
      <div className="block-tab todo-tab" role="tabpanel" aria-label="Todo list">
        <div className="feed-empty">
          <b>No todo list reported</b>
          <span>
            {state === "queued"
              ? "This step hasn't started, so no agent has written a list for it yet."
              : `${agent} didn't keep a todo list in this step. Anthill only shows a list the agent reports itself.`}
          </span>
        </div>
      </div>
    );
  }

  const running = stillRunning(state, ended);
  return (
    <div className="block-tab todo-tab" role="tabpanel" aria-label="Todo list">
      {lists.map((list) => (
        <TodoGroup key={list.owner} list={list} name={nameOf(list)} running={running} passes={passes} />
      ))}
    </div>
  );
}

function TodoGroup({ list, name, running, passes }: { list: BlockTodoList; name: string; running: boolean; passes: number }) {
  const { done, total } = todoProgress(list.items);
  return (
    <section className="todo-group" aria-label={`${name}'s todo list`}>
      <div className="todo-head">
        <i className="feed-avatar is-agent" aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </i>
        <span className="todo-who">
          <b>
            Reported by {name}
            {passes > 1 && list.pass !== undefined ? ` · pass ${list.pass}` : ""}
          </b>
          <span>The agent's own list, in its own words. Anthill does not infer it.</span>
        </span>
        <span className="todo-count">
          {done} of {total}
        </span>
      </div>
      <ul className="todo-list">
        {list.items.map((item, index) => (
          <TodoRow key={item.id ?? `${index}-${item.title}`} item={item} running={running} />
        ))}
      </ul>
      <span className="todo-note">
        {running ? "Last change " : "Final list · last change "}
        {clock(list.updatedAt)}
      </span>
    </section>
  );
}

function TodoRow({ item, running }: { item: TodoItem; running: boolean }) {
  const completed = item.status === "completed";
  const now = item.status === "in_progress" && running;
  // A step that ended with this item not done: left open, not done.
  const open = !running && !completed;
  const tone = completed ? "is-done" : now ? "is-now" : open ? "is-open" : "";
  return (
    <li className="todo-item">
      <i className={`todo-glyph ${tone}`} aria-hidden="true">
        {completed ? "✓" : ""}
      </i>
      <span className={`todo-title ${completed ? "is-done" : now ? "is-now" : ""}`}>{item.title}</span>
      {now ? <span className="todo-tail is-now">in progress</span> : open ? <span className="todo-tail is-open">left open</span> : null}
      {/* What the glyph alone says, for a reader who cannot see it; the
          states with a word of their own already say it. */}
      {completed || (!now && !open) ? <span className="sr-label">{completed ? "done" : "pending"}</span> : null}
    </li>
  );
}
