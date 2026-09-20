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
import { useAssistantThread, type ChatTurn } from "./assistant-thread.js";

export type DescribeChangeAssistantProps = {
  workflow: Workflow;
  /** Blocks the author has pointed at, as ids. Owned by the screen, because the canvas sets it. */
  mentions: string[];
  onMentionsChange: (mentions: string[]) => void;
  /** Called with the accepted result. The caller owns making it the workflow. */
  onApply: (next: Workflow) => void;
  onClose: () => void;
};

/** What one turn is, and the record that outlives this panel, live together. */
export type { ChatTurn };

const SETTING_KEY = "anthill.promptInterpreter";

function readSetting(): InterpreterId | undefined {
  try {
    const value = window.localStorage.getItem(SETTING_KEY);
    return value === "claude-code" || value === "codex" || value === "pi" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One readable line per change, for the proposal list. */
export function describeChange(change: EditChange): string {
  switch (change.kind) {
    case "agent-added":
      // Named before it is accepted. An agent that appeared without being
      // listed would be a change the author never agreed to (ANT-112).
      return `Add an agent: ${change.name}`;
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
  /*
    The thread is not this component's to lose. It is read from Anthill's own
    record when the panel opens and written back as it changes, so closing the
    panel — which unmounts everything here — leaves the conversation where it
    was rather than destroying it (ANT-82).
  */
  const { turns: chat, setTurns: setChat, ready, clear } = useAssistantThread(workflow.id);
  const [asking, setAsking] = useState(false);
  /** Clearing is two presses, because it is the one action that does lose the record. */
  const [confirmingClear, setConfirmingClear] = useState(false);
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
        setChat((current) => [
          ...current,
          {
            kind: "failed",
            error: response.error,
            ...(response.signedOut ? { signedOut: response.signedOut } : {}),
          },
        ]);
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
        {/* Only offered when there is something to lose, and never where the
            close button is: closing keeps the thread, and the two must not be
            a slip apart. */}
        {chat.length > 0 ? (
          <button
            type="button"
            className={confirmingClear ? "danger" : "link"}
            onClick={() => {
              if (!confirmingClear) {
                setConfirmingClear(true);
                return;
              }
              setConfirmingClear(false);
              clear();
            }}
          >
            {confirmingClear ? "Clear anyway" : "Clear history"}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          aria-label="Close the assistant"
          title="Close the assistant"
          onClick={() => {
            setConfirmingClear(false);
            onClose();
          }}
        >
          ✕
        </button>
      </header>

      {/* What clearing actually costs, said before it is done rather than after. */}
      {confirmingClear ? (
        <p className="assistant-clear-note">
          This removes {chat.length} {chat.length === 1 ? "message" : "messages"} from this
          workflow's conversation, on this machine, for good. Applied changes stay on the
          canvas; what was said about them does not.{" "}
          <button type="button" className="link" onClick={() => setConfirmingClear(false)}>
            Keep it
          </button>
        </p>
      ) : null}

      <div className="assistant-thread" ref={thread}>
        {/* Held back until the record has been read: a conversation that is
            about to arrive must not be announced as an empty one first. */}
        {ready && chat.length === 0 && !asking ? (
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
              <div key={key} className="assistant-failed">
                <p>{turn.error}</p>
                {/*
                  The one failure here with a way out, so it is the one that
                  offers it. Anthill cannot sign anyone in and does not see the
                  credential — it opens the CLI's own login in a terminal, and
                  the script it writes says so before it runs (ANT-111).

                  The request the author typed is still in the box. After
                  signing in they press Send again; nothing is cached and the
                  CLI is spawned fresh, so no restart is needed.
                */}
                {turn.signedOut ? (
                  <button
                    type="button"
                    className="assistant-signin"
                    onClick={() => void window.anthill.signInToInterpreter(turn.signedOut as InterpreterId)}
                  >
                    Open the login in a terminal
                  </button>
                ) : null}
              </div>
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
