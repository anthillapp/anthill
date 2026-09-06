/**
 * Steps back and forward through a workflow's own edits.
 *
 * Every change to the open workflow goes through one funnel in the screen, so
 * history can sit around that funnel and cover everything at once: a block
 * dragged on the canvas, a field typed in the inspector, an agent added, a
 * proposal applied from the assistant. There is no per-surface undo to keep in
 * step with the others, because there is only one place a change can happen.
 *
 * Whole snapshots rather than a diff log. A workflow is a small JSON object
 * held entirely in memory; storing the graph as it was costs a few kilobytes
 * per step and removes the entire class of bug where an inverse operation is
 * subtly wrong. The cap is what keeps that honest — a long session drops its
 * oldest steps rather than growing without end.
 *
 * The future is cleared by any new edit, which is the ordinary rule: once you
 * change something after stepping back, the branch you stepped out of is not
 * somewhere you can return to, and offering to would be a lie about what the
 * button does.
 *
 * Edits in quick succession collapse into one step. Typing a name fires an
 * edit per keystroke and dragging a block fires one per frame, so without this
 * Step back walks a rename backwards one letter at a time — technically a
 * history, useless as an undo. Time is the whole rule: anything under
 * `COALESCE_MS` after the last edit reads as a continuation of the same
 * gesture, and anything slower reads as a new decision.
 */

export type History<T> = {
  /** Older states, oldest first. */
  past: T[];
  /** States stepped back out of, nearest first. */
  future: T[];
  /** When the newest step was recorded, for coalescing. */
  at?: number;
};

/** Edits closer together than this are one gesture, so they are one step. */
export const COALESCE_MS = 500;

/** How many steps back a session keeps. Beyond this the oldest are forgotten. */
export const HISTORY_LIMIT = 50;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/**
 * Record that `previous` has just been replaced by something newer.
 *
 * Takes the state being left rather than the one arriving, because the caller
 * already holds the new one — this only has to remember what it displaced.
 */
export function recordEdit<T>(
  history: History<T>,
  previous: T,
  now: number = Date.now(),
): History<T> {
  // A continuation of the gesture already recorded: the step that is there
  // already points at the state before the gesture began, which is where Step
  // back should land. So only the clock moves.
  if (history.at !== undefined && now - history.at < COALESCE_MS && history.past.length > 0) {
    return { ...history, future: [], at: now };
  }
  return {
    past: [...history.past, previous].slice(-HISTORY_LIMIT),
    future: [],
    at: now,
  };
}

export function canStepBack<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canStepForward<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export type Step<T> = { history: History<T>; state: T } | undefined;

/** Step back, given the state currently on screen. `undefined` when there is nowhere to go. */
export function stepBack<T>(history: History<T>, current: T): Step<T> {
  const state = history.past[history.past.length - 1];
  if (state === undefined) return undefined;
  return {
    state,
    // The clock is dropped: a step is not an edit, and an edit made straight
    // after one is a new decision rather than a continuation of the gesture
    // that was just undone.
    history: { past: history.past.slice(0, -1), future: [current, ...history.future] },
  };
}

/** Step forward again, given the state currently on screen. */
export function stepForward<T>(history: History<T>, current: T): Step<T> {
  const [state, ...rest] = history.future;
  if (state === undefined) return undefined;
  return {
    state,
    history: { past: [...history.past, current].slice(-HISTORY_LIMIT), future: rest },
  };
}
