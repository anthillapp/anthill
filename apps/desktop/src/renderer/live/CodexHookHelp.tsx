import { useState } from "react";
import type { CodexHookStatus } from "../../shared/ipc.js";

/**
 * The one step only the person can take: approving Anthill's hooks in Codex
 * (ANT-138).
 *
 * Codex shows "Hooks need review" by itself when a session starts with hooks it
 * has not approved; in a session already open, /hooks opens the same review.
 * Its list holds every tool's unapproved hooks, not only Anthill's, which is
 * why this says Review hooks and never Trust all.
 */
export function CodexHookHelp({ status }: { status: CodexHookStatus }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  if (status.state === "ready") return <p className="hint">{status.message}</p>;

  // A check that could not say is never presented as "not approved".
  if (status.state !== "needs-trust" && status.state !== "disabled") {
    return (
      <div className="state-panel tone-unsure" role="status">
        <p>Anthill could not confirm how Codex treats its hooks. That does not mean they are unapproved.</p>
        <p>{status.message}</p>
        <p>Basic progress keeps working.</p>
      </div>
    );
  }

  return (
    <div className="state-panel tone-unsure" role="status">
      <p>{status.message}</p>
      <ol>
        <li>Start Codex. It shows <strong>Hooks need review</strong> – or, in a session already open, type <code>/hooks</code>.</li>
        <li>Choose <strong>Review hooks</strong>, not Trust all: the list also holds other tools’ hooks.</li>
        <li>{status.state === "disabled" ? "Switch on" : "Allow"} only the entries containing <code>anthill-observation-hook</code>.</li>
      </ol>
      <p>Basic progress keeps working meanwhile.</p>
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText("/hooks").then(() => {
          setCopied(true); setFailed(false);
        }).catch(() => setFailed(true));
      }}>{copied ? "Copied /hooks" : "Copy /hooks"}</button>
      {failed ? <p>Could not copy. Type <code>/hooks</code> in Codex.</p> : null}
    </div>
  );
}
