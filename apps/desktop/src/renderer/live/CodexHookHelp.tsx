import { useState } from "react";
import type { CodexHookStatus } from "../../shared/ipc.js";

export function CodexHookHelp({ status }: { status: CodexHookStatus }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  if (status.state === "ready") return <p className="hint">{status.message}</p>;
  return (
    <div className="state-panel tone-unsure" role="status">
      <p>{status.message}</p>
      <p>Basic progress keeps working. After changing hook permissions, start a new Codex session for detailed progress.</p>
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText("/hooks").then(() => {
          setCopied(true); setFailed(false);
        }).catch(() => setFailed(true));
      }}>{copied ? "Copied /hooks" : "Copy /hooks"}</button>
      {failed ? <p>Could not copy. Type <code>/hooks</code> in Codex.</p> : null}
    </div>
  );
}
