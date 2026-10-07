/**
 * "Run it again from your coding tool": the command that starts this workflow
 * again, from the plugin, as often as the user likes (ANT-281).
 *
 * The plugin's `run` reads the workflow.json at the path and starts a fresh run
 * in the session it is typed into, so all this card does is put that command —
 * or the bare path — on the clipboard. It starts nothing, and it does not
 * depend on anything having been exported: the plugin reads the file itself.
 *
 * What is shown is what is copied. The path is in double quotes in both,
 * because the one the status bar names lives under "Application Support", and
 * `~` stays as it is: the plugin's server expands it.
 */

import { useEffect, useRef, useState } from "react";
import type { HarnessTarget } from "@anthill/workflow-schema";

import { interpreterLogoBackground } from "./interpreter-logos.js";

/** The two tools the card offers a command for. */
export type RunTool = Extract<HarnessTarget, "claude-code" | "codex">;

const TOOLS: { id: RunTool; label: string; verb: string }[] = [
  // Claude Code namespaces a plugin's skill: `/anthill:workflow`, never `/anthill`.
  { id: "claude-code", label: "Claude Code", verb: "/anthill:workflow run" },
  { id: "codex", label: "Codex", verb: "$anthill run" },
];

/** The last tool chosen, remembered on this machine for the next time. */
export const RUN_TOOL_KEY = "anthill.run-tool";

/** How long a pressed button says "Copied". */
export const COPIED_MS = 1600;

export function runCommand(tool: RunTool, path: string): string {
  return `${verbFor(tool)} "${path}"`;
}

function verbFor(tool: RunTool): string {
  return TOOLS.find((entry) => entry.id === tool)?.verb ?? TOOLS[0]!.verb;
}

function isRunTool(value: unknown): value is RunTool {
  return TOOLS.some((entry) => entry.id === value);
}

/** The remembered choice, else the tool the workflow was made for, else Claude Code. */
function initialTool(target: HarnessTarget | undefined): RunTool {
  try {
    const stored = window.localStorage.getItem(RUN_TOOL_KEY);
    if (isRunTool(stored)) return stored;
  } catch {
    // Storage unavailable: fall through to the workflow's own tool.
  }
  return isRunTool(target) ? target : "claude-code";
}

type RunAgainCardProps = {
  /** The workflow.json, as the user reads it: home-relative where it can be. */
  path: string;
  /** The tool the workflow targets, the default before anything is remembered. */
  target?: HarnessTarget;
};

export function RunAgainCard({ path, target }: RunAgainCardProps) {
  const [tool, setTool] = useState<RunTool>(() => initialTool(target));
  const [copied, setCopied] = useState<"command" | "path" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const choose = (next: RunTool) => {
    setTool(next);
    try {
      window.localStorage.setItem(RUN_TOOL_KEY, next);
    } catch {
      // Nothing to do: the choice holds until the dialog closes.
    }
  };

  const copy = (which: "command" | "path") => {
    const text = which === "command" ? runCommand(tool, path) : path;
    void navigator.clipboard.writeText(text).then(
      () => {
        clearTimeout(timer.current);
        setCopied(which);
        timer.current = setTimeout(() => setCopied(null), COPIED_MS);
      },
      () => {
        // The clipboard refused; the button simply does not say "Copied".
      },
    );
  };

  const command = runCommand(tool, path);
  return (
    <section className="run-again" aria-label="Run it again from your coding tool">
      <div className="run-again-top">
        <span className="run-again-titles">
          <span className="run-again-title">Run it again from your coding tool</span>
          <span className="run-again-desc">
            The Anthill plugin reads the workflow from this path and starts a fresh run each time.
          </span>
        </span>
        <div className="run-again-tools" role="tablist" aria-label="Coding tool">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tool === entry.id}
              className={tool === entry.id ? "is-on" : undefined}
              onClick={() => choose(entry.id)}
            >
              <i aria-hidden="true" style={{ backgroundImage: interpreterLogoBackground(entry.id) }} />
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="run-again-command">
        <span className="run-again-command-text export-mono" title={command} data-testid="run-command">
          <span className="verb">{verbFor(tool)}</span> "{path}"
        </span>
        <button
          type="button"
          className={`run-again-copy is-dark${copied === "command" ? " is-copied" : ""}`}
          onClick={() => copy("command")}
        >
          {copied === "command" ? "Copied" : "Copy command"}
        </button>
      </div>

      <div className="run-again-path">
        <span className="label">Path</span>
        {/* Cut at the start so the file name stays; the bdi keeps `~/` at the front. */}
        <span className="run-again-path-text export-mono" title={path}>
          <bdi>{path}</bdi>
        </span>
        <button
          type="button"
          className={`run-again-copy${copied === "path" ? " is-copied" : ""}`}
          onClick={() => copy("path")}
        >
          {copied === "path" ? "Copied" : "Copy path"}
        </button>
      </div>
    </section>
  );
}
