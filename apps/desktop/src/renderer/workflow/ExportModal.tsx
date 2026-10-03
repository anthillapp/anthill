/**
 * Export: a handed-over workflow, kept so it can be used again (ANT-265).
 *
 * A workflow that arrived from a coding session has no `Prompt` that starts
 * anything: that would mint a second, unrelated run for the work the session
 * is already doing. But the workflow is still worth keeping. This writes it out
 * as the same agent files the Hand-over writes, and as `Prompt.md` — the
 * compiled workflow with no run marker, so every reuse registers a run of its
 * own instead of claiming this session's.
 *
 * Exporting never binds, starts or approves anything. It writes files, through
 * the same all-or-nothing export the Hand-over uses, and says which.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  DEFAULT_TARGET,
  HARNESS_PROFILES,
  WorkflowCompileError,
  compile,
  runRoot,
  type GeneratedFile,
} from "@anthill/workflow";

/** The compiled workflow's file name in the export. */
export const PROMPT_FILE = "Prompt.md";

export type ExportModalProps = {
  workflow: Workflow;
  onClose: () => void;
};

/** What the last Export press came to. */
type Outcome =
  | { kind: "none" }
  | { kind: "writing" }
  | { kind: "done"; directory: string; written: string[] }
  | { kind: "failed"; error: string; rolledBack: boolean };

/** The export glyph: the same icon as the toolbar's Prompt on a handover. */
export function ExportIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
      <path
        d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Toggle({
  checked,
  onToggle,
  title,
  detail,
  description,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  detail: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className="export-toggle"
      onClick={onToggle}
    >
      <i className={`export-box${checked ? " is-on" : ""}`} aria-hidden="true">
        {checked ? "✓" : ""}
      </i>
      <span className="export-toggle-text">
        <span className="export-toggle-head">
          <span className="export-toggle-title">{title}</span>
          <span className="export-mono">{detail}</span>
        </span>
        <span className="export-toggle-desc">{description}</span>
      </span>
    </button>
  );
}

export function ExportModal({ workflow, onClose }: ExportModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const harness = HARNESS_PROFILES[workflow.target ?? DEFAULT_TARGET];

  /** Without a marker: compiled with no step openings, so nothing names a run. */
  const compiled = useMemo(() => {
    try {
      return compile(workflow);
    } catch (problem) {
      if (problem instanceof WorkflowCompileError) return null;
      throw problem;
    }
  }, [workflow]);
  const agentFiles: GeneratedFile[] = compiled?.files ?? [];
  const hasAgents = agentFiles.length > 0;

  const [withAgents, setWithAgents] = useState(true);
  const [withPrompt, setWithPrompt] = useState(true);
  const [folder, setFolder] = useState<string | null>(() => runRoot(workflow) ?? null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const done = outcome.kind === "done";

  const chosen = [
    ...(hasAgents && withAgents ? agentFiles.map((file) => file.path) : []),
    ...(withPrompt ? [PROMPT_FILE] : []),
  ];
  const nothingChosen = chosen.length === 0;

  // Into the dialog on open, and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const change = useCallback(async () => {
    const picked = await window.anthill.chooseRunFolder();
    if (picked) setFolder(picked);
  }, []);

  const write = useCallback(async () => {
    if (!compiled || nothingChosen || outcome.kind === "writing") return;
    const files = [
      ...(hasAgents && withAgents
        ? agentFiles.map(({ path, content }) => ({ path, content }))
        : []),
      ...(withPrompt ? [{ path: PROMPT_FILE, content: `${compiled.prompt.trimEnd()}\n` }] : []),
    ];
    setOutcome({ kind: "writing" });
    try {
      // No folder yet: the export asks for one itself.
      const response = await window.anthill.exportWorkflow({
        files,
        ...(folder ? { root: folder } : {}),
      });
      if (response.ok) {
        setFolder(response.directory);
        setOutcome({ kind: "done", directory: response.directory, written: files.map((file) => file.path) });
      } else if ("cancelled" in response) {
        // Closed the folder dialog: nothing was written, and nothing to say.
        setOutcome({ kind: "none" });
      } else {
        setOutcome({ kind: "failed", error: response.error, rolledBack: response.rolledBack !== false });
      }
    } catch (problem) {
      setOutcome({
        kind: "failed",
        error: problem instanceof Error ? problem.message : "The files could not be written.",
        rolledBack: true,
      });
    }
  }, [agentFiles, compiled, folder, hasAgents, nothingChosen, outcome.kind, withAgents, withPrompt]);

  const agentDir = harness.agentDir ? `${harness.agentDir}/` : "";
  const primaryBlocked = !done && (nothingChosen || !compiled || outcome.kind === "writing");

  return (
    <div
      className="modal-scrim export-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="export-top">
          <span className="export-tile" aria-hidden="true">
            <ExportIcon size={15} />
          </span>
          <div className="export-titles">
            <h4 id={titleId}>{done ? "Exported" : "Export this workflow"}</h4>
            <p>
              {done
                ? "Ready to reuse — nothing was started."
                : "Agent files and Prompt.md, for running it again later."}
            </p>
          </div>
          <span className="spacer" />
          <button type="button" className="export-close" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="export-body">
          {done ? (
            <>
              <section className="export-written">
                <div className="export-written-head">
                  <i aria-hidden="true" />
                  <span>
                    {plural(outcome.written.length, "file")} written to {outcome.directory}
                  </span>
                </div>
                <ul>
                  {outcome.written.map((path) => (
                    <li key={path}>
                      <span className="tick" aria-hidden="true">
                        ✓
                      </span>
                      <span className="export-mono">{path}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <p className="export-note">
                To run it again, open the folder's workflow in Anthill and press Prompt, or paste
                Prompt.md into your coding tool. Anthill follows that run as a new session.
              </p>
            </>
          ) : (
            <>
              <p className="export-intro">
                This workflow came from a coding session. Export it to keep a copy someone can
                reuse later: open it in Anthill and press Prompt, or paste <b>Prompt.md</b> into
                Claude Code or Codex. Exporting starts nothing.
              </p>

              {!compiled ? (
                <p className="export-intro">Fix the problems listed under Problems to export it.</p>
              ) : null}

              <div className="export-options">
                {hasAgents ? (
                  <>
                    <Toggle
                      checked={withAgents}
                      onToggle={() => setWithAgents((on) => !on)}
                      title="Agent files"
                      detail={`${agentDir} · ${plural(agentFiles.length, "file")}`}
                      description="One file per agent, so the coding tool can delegate to the same roles."
                    />
                    {withAgents ? (
                      <ul className="export-files">
                        {agentFiles.map((file) => (
                          <li key={file.path}>
                            <span className="export-mono">{file.path}</span>
                            <span className="spacer" />
                            {file.steps !== undefined ? (
                              <span className="steps">{plural(file.steps, "step")}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="export-rule" />
                  </>
                ) : null}
                <Toggle
                  checked={withPrompt}
                  onToggle={() => setWithPrompt((on) => !on)}
                  title="Prompt.md"
                  detail="the compiled workflow"
                  description="Written without this session's run marker, so every reuse starts its own run."
                />
              </div>

              <div className="export-folder">
                <span className="label">Folder</span>
                <span className="value export-mono">{folder ?? "Not chosen yet"}</span>
                <button type="button" onClick={() => void change()}>
                  Change…
                </button>
              </div>

              {outcome.kind === "failed" ? (
                <section className="handover-receipt is-failed" role="alert">
                  <span className="dot" aria-hidden="true" />
                  <div>
                    <p className="handover-receipt-head">
                      {outcome.rolledBack ? "Nothing was written" : "The files were left part-written"}
                    </p>
                    <p className="hint">{outcome.error}</p>
                  </div>
                </section>
              ) : null}
            </>
          )}
        </div>

        <footer className="export-foot">
          <button
            type="button"
            className={`export-primary${primaryBlocked ? " is-blocked" : ""}`}
            aria-disabled={primaryBlocked ? true : undefined}
            onClick={() => (done ? onClose() : void write())}
          >
            {done ? "Done" : "Export"}
          </button>
          {done ? null : (
            <button type="button" className="export-cancel" onClick={onClose}>
              Cancel
            </button>
          )}
          <span className="spacer" />
          <span className="export-count">{done ? "" : plural(chosen.length, "file")}</span>
        </footer>
      </div>
    </div>
  );
}
