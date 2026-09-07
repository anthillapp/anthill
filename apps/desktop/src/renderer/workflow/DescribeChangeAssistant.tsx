/**
 * Editing the graph in words: the surface over ANT-12's contract.
 *
 * The order of authority is the whole design. The author describes; the
 * interpreter proposes operations against the ids it was shown; Anthill
 * applies them to a copy and shows what would change; and nothing touches the
 * open workflow until the author says apply. Submitting a request mutates
 * nothing, a proposal that cannot be honoured refuses whole with its reason,
 * and an interpreter that declines is shown as declining — its "no" is a
 * result, not an error.
 *
 * This was a modal (ANT-37 replaced it). Two costs paid for the dialog: it
 * took the author off the canvas, and every request started from an empty
 * sheet, so a second thought about the same edit read as an unrelated one.
 * It is now a thread in the sidebar, and two properties follow from that:
 *
 * - **Nothing leaves the thread.** A proposal that was applied or discarded
 *   stays visible as a record of what was decided. What ends is its
 *   *applicability*: only the newest unresolved proposal carries buttons, so
 *   there is never a stack of live actions to press out of order.
 * - **Blocks are referenced by pointing.** While this panel is open a canvas
 *   click adds the block as a mention instead of selecting it — the inspector
 *   is not on screen to select into. Mentions are held as ids and resolved to
 *   names at render time, so a block renamed between being clicked and being
 *   sent is still the same block.
 *
 * The interpreter plumbing is the drafting flow's, reused deliberately: same
 * preflight, same locked-down process, same cancellation, same stored
 * preference. One way of running an interpreter is one set of promises to
 * keep about it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  applyEditProposal,
  buildEditInstruction,
  parseEditProposal,
  type EditChange,
  type EditProposal,
} from "@anthill/workflow";
import type { InterpreterId } from "@anthill/workflow";
import type { InterpreterInfo } from "../../shared/ipc.js";

export type DescribeChangeAssistantProps = {
  workflow: Workflow;
  /** Blocks the author has pointed at, as ids. Owned by the screen, because the canvas sets it. */
  mentions: string[];
  onMentionsChange: (mentions: string[]) => void;
  /** Called with the accepted result. The caller owns making it the workflow. */
  onApply: (next: Workflow) => void;
  onClose: () => void;
};

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
 * promise is that nothing leaves it.
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
       * work with a graph computed before those edits existed.
       */
      proposal: EditProposal;
      resolved?: "applied" | "discarded";
      /** Why a later application refused, when one did. */
      error?: string;
    };

const SETTING_KEY = "anthill.promptInterpreter";

function readSetting(): InterpreterId | undefined {
  try {
    const value = window.localStorage.getItem(SETTING_KEY);
    return value === "claude-code" || value === "codex" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One readable line per change, for the proposal list. */
export function describeChange(change: EditChange): string {
  switch (change.kind) {
    case "block-added":
      return `Add a block: ${change.name}`;
    case "block-updated":
      return `Change the block: ${change.name}`;
    case "block-removed":
      return `Remove the block: ${change.name}`;
    case "connected":
      return `Connect ${change.source} → ${change.target}`;
    case "disconnected":
      return `Remove the connection ${change.source} → ${change.target}`;
    case "connection-updated":
      return `Change a connection's label or condition`;
  }
}

/** Whether a change takes something away — the list makes those loud. */
function destructive(change: EditChange): boolean {
  return change.kind === "block-removed" || change.kind === "disconnected";
}

/**
 * The question this next request would be answering, if any.
 *
 * Only the last turn counts. Once anything else has happened — a proposal, a
 * refusal, a failure — the exchange has moved on and a new request stands on
 * its own.
 */
export function pendingQuestion(
  chat: readonly ChatTurn[],
): { request: string; question: string } | undefined {
  const last = chat[chat.length - 1];
  return last?.kind === "question"
    ? { request: last.asked, question: last.question }
    : undefined;
}

/** The index of the one proposal that may still be acted on, if there is one. */
export function actionableTurn(chat: readonly ChatTurn[]): number {
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const turn = chat[index];
    if (turn.kind === "proposal") return turn.resolved ? -1 : index;
  }
  return -1;
}

export function DescribeChangeAssistant({
  workflow,
  mentions,
  onMentionsChange,
  onApply,
  onClose,
}: DescribeChangeAssistantProps) {
  const [request, setRequest] = useState("");
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [interpreters, setInterpreters] = useState<InterpreterInfo[] | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void window.anthill.detectInterpreters().then((found) => {
      if (live) setInterpreters(found);
    });
    return () => {
      live = false;
    };
  }, []);

  const chosen = useMemo(() => {
    const preferred = readSetting();
    const available = (interpreters ?? []).filter((item) => item.available);
    return available.find((item) => item.id === preferred) ?? available[0];
  }, [interpreters]);

  /**
   * Seconds since the request went out.
   *
   * These take tens of seconds. A static ellipsis or a lone spinner reads as
   * hung well before then; a number that keeps moving is the difference
   * between "still working" and "stuck", and it costs one interval.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!asking) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [asking]);

  /**
   * The thread grows downward, so the newest turn is the one to be looking at.
   * Guarded because scrolling is a convenience: an environment without
   * `scrollTo` should get a panel that works, not one that throws on render.
   */
  useEffect(() => {
    const box = thread.current;
    if (typeof box?.scrollTo === "function") box.scrollTo({ top: box.scrollHeight });
  }, [chat, asking]);

  const nameOf = useCallback(
    (id: string) => workflow.nodes.find((node) => node.id === id)?.name || "Unnamed block",
    [workflow],
  );

  const resolveLast = useCallback((how: "applied" | "discarded") => {
    setChat((current) => {
      const index = actionableTurn(current);
      if (index < 0) return current;
      return current.map((turn, at) =>
        at === index && turn.kind === "proposal" ? { ...turn, resolved: how } : turn,
      );
    });
  }, []);

  /**
   * Apply the proposal at `index`, whenever it was made.
   *
   * Any proposal in the thread can be applied, not only the newest, because
   * the author may well decide after two more attempts that the first answer
   * was the right one. What makes that safe is that the operations are applied
   * to the graph as it is *now*: an older proposal either still fits and does
   * exactly what it says, or it refuses whole and says why — it can never
   * quietly restore the workflow to the shape it had when the proposal was
   * made, discarding everything since.
   */
  const applyTurn = useCallback(
    (index: number) => {
      setChat((current) => {
        const turn = current[index];
        if (turn?.kind !== "proposal") return current;
        const applied = applyEditProposal(workflow, turn.proposal);
        if (!applied.ok) {
          return current.map((item, at) =>
            at === index && item.kind === "proposal" ? { ...item, error: applied.error } : item,
          );
        }
        onApply(applied.workflow);
        return current.map((item, at) =>
          at === index && item.kind === "proposal"
            ? // The list is rewritten to what actually happened just now, which
              // for an older proposal need not be what it would have done then.
              { ...item, resolved: "applied", changes: applied.changes, error: undefined }
            : item,
        );
      });
    },
    [workflow, onApply],
  );

  const submit = useCallback(async () => {
    const text = request.trim();
    if (!chosen || text.length === 0 || asking) return;

    // At most one proposal can be acted on, so an older one steps aside rather
    // than sitting there with live buttons under a newer request.
    resolveLast("discarded");
    // Read before the turn is added, so it sees the question rather than this.
    const answering = pendingQuestion(chat);
    const asked = [...mentions];
    setChat((current) => [...current, { kind: "user", text, mentions: asked }]);
    setRequest("");
    onMentionsChange([]);
    setAsking(true);

    const response = await window.anthill.draftFromPrompt({
      interpreterId: chosen.id,
      instruction: buildEditInstruction(workflow, { kind: "workflow" }, text, asked, answering),
    });
    setAsking(false);

    if (!response.ok) {
      // A cancelled request leaves no turn: the author took it back, and a
      // record of a thing that never ran would be noise in the thread.
      if (!response.cancelled) {
        setChat((current) => [...current, { kind: "failed", error: response.error }]);
      }
      return;
    }

    const parsed = parseEditProposal(response.reply);
    if (!parsed.ok) {
      setChat((current) => [...current, { kind: "failed", error: parsed.error }]);
      return;
    }
    if (parsed.proposal.question) {
      // Not a refusal and not a change: one decision it will not make on the
      // author's behalf. The workflow is untouched — nothing is applied on any
      // path until a proposal exists and the author accepts it.
      setChat((current) => [
        ...current,
        {
          kind: "question",
          question: parsed.proposal.question as string,
          // The request being clarified, which is this one unless this one was
          // itself an answer — then the original still stands.
          asked: answering?.request ?? text,
        },
      ]);
      return;
    }
    if (parsed.proposal.ops.length === 0) {
      // The contract's refusal shape: nothing proposed, the reason in the
      // summary. A decline, in the interpreter's own words — not an error.
      setChat((current) => [...current, { kind: "declined", summary: parsed.proposal.summary }]);
      return;
    }

    const applied = applyEditProposal(workflow, parsed.proposal);
    if (!applied.ok) {
      setChat((current) => [...current, { kind: "failed", error: applied.error }]);
      return;
    }
    setChat((current) => [
      ...current,
      {
        kind: "proposal",
        summary: parsed.proposal.summary,
        changes: applied.changes,
        proposal: parsed.proposal,
      },
    ]);
  }, [chosen, request, workflow, mentions, asking, onMentionsChange, resolveLast, chat]);

  const live = actionableTurn(chat);



  return (
    <div className="assistant">
      <header className="assistant-top">
        {/* No scope suffix. Editing through the assistant always addresses the
            whole workflow, never whatever happens to be selected. */}
        <h2>Assistant</h2>
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="Close the assistant"
          title="Close the assistant"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="assistant-thread" ref={thread}>
        {chat.length === 0 && !asking ? (
          <p className="assistant-idle">
            Describe a change to the diagram and{" "}
            {chosen ? chosen.label : "a local CLI"} proposes it. Nothing changes until you
            apply it.
          </p>
        ) : null}

        {chat.map((turn, index) => {
          const key = `t${index}`;
          if (turn.kind === "user") {
            return (
              <div key={key} className="assistant-said">
                {turn.mentions.length > 0 ? (
                  <span className="assistant-said-mentions">
                    {turn.mentions.map((id) => (
                      <span key={id} className="mention-pill is-small">
                        {nameOf(id)}
                      </span>
                    ))}
                  </span>
                ) : null}
                {turn.text}
              </div>
            );
          }
          if (turn.kind === "question") {
            return (
              <p key={key} className="assistant-question" role="status">
                {turn.question}
              </p>
            );
          }
          if (turn.kind === "declined") {
            return (
              <p key={key} className="assistant-declined">
                {chosen?.label ?? "The interpreter"} declined: <em>{turn.summary}</em>
              </p>
            );
          }
          if (turn.kind === "failed") {
            return (
              <p key={key} className="assistant-failed">
                {turn.error}
              </p>
            );
          }
          if (turn.kind !== "proposal") return null;
          return (
            <div key={key} className="assistant-proposal">
              <p className="assistant-summary">{turn.summary}</p>
              <ul className="assistant-changes">
                {turn.changes.map((change, at) => (
                  <li key={at} className={destructive(change) ? "is-destructive" : undefined}>
                    {describeChange(change)}
                  </li>
                ))}
              </ul>
              {turn.error ? (
                <p className="assistant-failed assistant-proposal-error">{turn.error}</p>
              ) : null}

              {index === live ? (
                <div className="assistant-proposal-actions">
                  <button type="button" className="primary" onClick={() => applyTurn(index)}>
                    Apply
                  </button>
                  {/* Deliberately does not resolve the turn: a follow-up is a
                      continuation of this request, not a new one. */}
                  <button type="button" onClick={() => composer.current?.focus()}>
                    Adjust…
                  </button>
                  <button type="button" onClick={() => resolveLast("discarded")}>
                    Discard
                  </button>
                </div>
              ) : (
                <div className="assistant-proposal-actions is-past">
                  <p className="assistant-resolved">
                    {turn.resolved === "applied" ? "Applied to the canvas." : "Discarded."}
                  </p>
                  {/* Any earlier answer can still be the right one. It applies
                      to the graph as it is now, so it either fits or refuses. */}
                  <button type="button" onClick={() => applyTurn(index)}>
                    Apply again
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {asking ? (
          <div className="assistant-asking" aria-live="polite">
            <span className="think-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              {chosen?.label} is reading the workflow… ({elapsed}s)
            </span>
            <button type="button" className="link" onClick={() => void window.anthill.cancelPromptDraft()}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>

      <div className="assistant-composer">
        {mentions.length > 0 ? (
          <div className="assistant-mentions">
            {mentions.map((id) => (
              <span key={id} className="mention-pill">
                {nameOf(id)}
                <button
                  type="button"
                  aria-label={`Stop referring to ${nameOf(id)}`}
                  title={`Stop referring to ${nameOf(id)}`}
                  onClick={() => onMentionsChange(mentions.filter((item) => item !== id))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={composer}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="e.g. Split this task across several subagents, each owning a separate part of the work."
          rows={3}
          disabled={asking}
        />
        <p className="hint">Click blocks on the canvas to reference them here.</p>

        <button
          type="button"
          className="primary assistant-send"
          disabled={!chosen || request.trim().length === 0 || asking}
          onClick={() => void submit()}
        >
          {asking ? "Sending…" : "Send"}
        </button>
        {!chosen && interpreters !== null ? (
          <p className="hint warn">No local interpreter is available.</p>
        ) : null}
      </div>
    </div>
  );
}
