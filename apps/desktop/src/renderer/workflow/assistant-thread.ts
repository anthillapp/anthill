/**
 * The assistant's thread: what a turn is, and how one survives the panel.
 *
 * The thread used to be `useState` inside the panel, which meant the close
 * button destroyed it — reopening the assistant over the same workflow began
 * from an empty sheet, and every request, refusal and proposal argued out was
 * gone (ANT-82). The sidebar's stated promise is that nothing leaves the
 * thread, and a record that cannot survive its own close button does not keep
 * it.
 *
 * The record now lives in Anthill's own folder, keyed by the workflow's id —
 * minted when the workflow is created and written into its file, so the same
 * conversation comes back after a close, a workflow switch, a save, and a
 * restart, and a conversation begun before the first save is already attached
 * to the thing it was about.
 *
 * Two things this module is careful about:
 *
 * - **Restoring shows; it never does.** A proposal comes back with the state it
 *   was left in — pending, applied, discarded, refused — and applying is still
 *   the author pressing Apply, against the graph as it is then. Nothing is
 *   replayed on the way in.
 * - **A record is read defensively.** It was written by some version of
 *   Anthill, possibly not this one. A turn whose shape this version does not
 *   understand is dropped and the rest of the conversation is kept: losing one
 *   line is a smaller lie than refusing the thread, and far smaller than
 *   handing `applyEditProposal` something it cannot honour.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { parseEditProposal, type EditChange, type EditProposal } from "@anthill/workflow";

/**
 * One turn in the thread.
 *
 * `declined` and `failed` are turns rather than a separate error banner: a
 * refusal is a result the author asked for and belongs in the record beside
 * the request that drew it, not in a strip that the next message wipes.
 *
 * Waiting is deliberately *not* a turn. It has no place in the record — it is
 * a thing happening now, not a thing that happened — and modelling it as one
 * would mean adding and then removing an entry from a history whose whole
 * promise is that nothing leaves it. It is also why a request in flight when
 * the panel closes leaves no trace: it never became part of the record.
 */
export type ChatTurn =
  | { kind: "user"; text: string; mentions: string[] }
  | { kind: "declined"; summary: string }
  /**
   * The interpreter needs one thing decided before it can propose anything.
   *
   * `asked` travels with it so the answer can be sent back as the second half
   * of one exchange. Without it, "the login one" is read as a fresh request
   * and means nothing (ANT-36).
   */
  | { kind: "question"; question: string; asked: string }
  | { kind: "failed"; error: string }
  | {
      kind: "proposal";
      summary: string;
      /** What it would do, as of the last time it was worked out. */
      changes: EditChange[];
      /**
       * The operations themselves, kept so the proposal can be applied later.
       *
       * Not the resulting workflow. A proposal is a set of operations against
       * ids, and the workflow it would produce depends on what the workflow is
       * *now* — so applying is always a fresh `applyEditProposal` against the
       * current graph. Storing the result instead was a real bug: a proposal
       * held while the author edited the canvas would, on Apply, replace their
       * work with a graph computed before those edits existed. It is also what
       * makes a restored proposal safe: it is still a set of operations, and it
       * still meets the graph as it is when the author presses Apply.
       */
      proposal: EditProposal;
      resolved?: "applied" | "discarded";
      /** Why a later application refused, when one did. */
      error?: string;
    };

const CHANGE_KINDS = new Set([
  "block-added",
  "block-updated",
  "block-removed",
  "connected",
  "disconnected",
  "connection-updated",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function changes(value: unknown): EditChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is EditChange => isRecord(item) && CHANGE_KINDS.has(String(item.kind)),
  );
}

/**
 * One stored turn, or nothing.
 *
 * A proposal is checked by the same parser the live path uses, rather than by a
 * second opinion written here about what a valid proposal is. Two definitions
 * would eventually disagree, and the one that disagreed quietly would be this
 * one — handing `applyEditProposal` operations it was never promised.
 */
export function readTurn(value: unknown): ChatTurn | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "user": {
      const text = str(value.text);
      if (text === undefined) return undefined;
      const mentions = Array.isArray(value.mentions)
        ? value.mentions.filter((id): id is string => typeof id === "string")
        : [];
      return { kind: "user", text, mentions };
    }
    case "declined": {
      const summary = str(value.summary);
      return summary === undefined ? undefined : { kind: "declined", summary };
    }
    case "question": {
      const question = str(value.question);
      const asked = str(value.asked);
      if (question === undefined || asked === undefined) return undefined;
      return { kind: "question", question, asked };
    }
    case "failed": {
      const error = str(value.error);
      return error === undefined ? undefined : { kind: "failed", error };
    }
    case "proposal": {
      const summary = str(value.summary);
      if (summary === undefined) return undefined;
      const parsed = parseEditProposal(JSON.stringify(value.proposal));
      if (!parsed.ok) return undefined;
      const resolved = value.resolved === "applied" || value.resolved === "discarded" ? value.resolved : undefined;
      const error = str(value.error);
      return {
        kind: "proposal",
        summary,
        changes: changes(value.changes),
        proposal: parsed.proposal,
        ...(resolved ? { resolved } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** A whole stored thread, in order, with the turns this version cannot read dropped. */
export function readTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value) {
    const turn = readTurn(item);
    if (turn) turns.push(turn);
  }
  return turns;
}

/**
 * The record's side of the wire, when there is one.
 *
 * A renderer can meet a main process that does not have these channels — that
 * is what `IPC_CONTRACT` exists to describe — and an assistant that throws on
 * open would be a worse answer than one whose thread lasts only as long as the
 * panel. So the absence is handled here, once, rather than at three call sites.
 */
function record(): {
  read: (id: string) => Promise<unknown[]>;
  write: (id: string, turns: ChatTurn[]) => Promise<void>;
  clear: (id: string) => Promise<void>;
} | undefined {
  const api = window.anthill as Partial<typeof window.anthill> | undefined;
  if (
    typeof api?.assistantThreadRead !== "function" ||
    typeof api.assistantThreadWrite !== "function" ||
    typeof api.assistantThreadClear !== "function"
  ) {
    return undefined;
  }
  return {
    read: (id) => api.assistantThreadRead!(id),
    write: (id, turns) => api.assistantThreadWrite!(id, turns),
    clear: (id) => api.assistantThreadClear!(id),
  };
}

export type AssistantThread = {
  turns: ChatTurn[];
  setTurns: (next: ChatTurn[] | ((current: ChatTurn[]) => ChatTurn[])) => void;
  /** Whether the stored record has been read. Nothing is written before it has. */
  ready: boolean;
  /** Forget this workflow's thread. Asked for explicitly, never inferred. */
  clear: () => void;
};

/**
 * This workflow's thread, loaded once and written back as it changes.
 *
 * The load is what the two ordering hazards here are about, and both would
 * show up as a conversation quietly emptying:
 *
 * - Nothing is written until the record has been read. The panel mounts with
 *   an empty thread, and an eager write would store that emptiness over the
 *   conversation it was about to load.
 * - A load that arrives after the workflow has changed again is dropped. The
 *   workflow's id is captured per read and checked against the current one, so
 *   a slow read for the workflow just left cannot land in the one just opened.
 */
export function useAssistantThread(workflowId: string): AssistantThread {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [ready, setReady] = useState(false);
  /**
   * The workflow whose record has been read, so a write cannot address another
   * — and, when a read fails, so no write happens at all. A failed read gives
   * back an empty thread, and writing that back would turn "could not read the
   * conversation" into "there is no conversation", which is the very loss this
   * is here to prevent.
   */
  const loaded = useRef<string | undefined>(undefined);
  /** The value last known to match the record, by identity. Not re-written. */
  const settled = useRef<ChatTurn[] | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setReady(false);
    setTurns([]);
    loaded.current = undefined;
    settled.current = undefined;
    const store = record();
    if (!workflowId || !store) {
      // A workflow with no id has nowhere to keep a thread. The panel still
      // works; the conversation simply lasts as long as it is open, which is
      // what it did for every workflow before this existed.
      setReady(true);
      return () => {
        live = false;
      };
    }
    void store
      .read(workflowId)
      .then((stored) => {
        if (!live) return;
        const restored = readTurns(stored);
        settled.current = restored;
        loaded.current = workflowId;
        setTurns(restored);
        setReady(true);
      })
      .catch(() => {
        if (!live) return;
        setReady(true);
      });
    return () => {
      live = false;
    };
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId || loaded.current !== workflowId) return;
    if (settled.current === turns) return;
    settled.current = turns;
    void record()?.write(workflowId, turns).catch(() => undefined);
  }, [turns, workflowId, ready]);

  const clear = useCallback(() => {
    const empty: ChatTurn[] = [];
    settled.current = empty;
    setTurns(empty);
    if (workflowId) void record()?.clear(workflowId).catch(() => undefined);
  }, [workflowId]);

  return { turns, setTurns, ready, clear };
}
