/**
 * The single prompt the user copies.
 *
 * Three parts, in this order and for a reason:
 *
 * 1. **The marker.** First, so it is in the very first thing the tool records
 *    and a session can be recognised from its opening user message.
 * 2. **Set-up.** Any agent files the harness supports, written out in full, so
 *    the pasted prompt is self-sufficient. Exporting files from Anthill stays
 *    optional — the copy-paste path must work on its own, and a prompt that
 *    silently depended on a separate export would fail in a way the user could
 *    not see.
 * 3. **The workflow.** Exactly what `compile()` produces, unchanged.
 *
 * Anthill does not run any of this. The user pastes it into their own Codex or
 * Claude Code and starts it there.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { compile, executableBlocks, type CompileResult } from "@anthill/workflow";

import { cliInstruction, echoInstruction, renderMarker, type RunMarker } from "./marker.js";

export type BootstrapResult = CompileResult & {
  /** The prompt to copy: marker, set-up, then the workflow. */
  bootstrapPrompt: string;
  marker: RunMarker;
};

export type BootstrapOptions = {
  /**
   * Instruct the harness to report through the Anthill CLI instead of
   * printing marker lines.
   *
   * The CLI is only present where the app runs as a CLI (Linux), so this
   * is set by the shell that knows it has the binary. A shell that cannot
   * ask leaves the prompt to the marker lines, which work everywhere.
   */
  reportViaCli?: boolean;
};

/**
 * The steps a marker can name.
 *
 * Start and end carry no work, so nobody announces them; everything else is
 * something the agent can be asked to call out as it reaches it.
 *
 * Exported because this list is also what a step announcement can be *read
 * back* as: the run keeps it so a marker arriving later can be reported in the
 * author's own words. One definition, so what a notification can name is
 * exactly what the prompt asked for and never a step the session was never
 * told about.
 */
export function workflowSteps(workflow: Workflow): { id: string; name: string }[] {
  // The order the compiled prompt uses, not the order the blocks were drawn
  // in. These were different lists of the same blocks: the prompt numbered
  // them by a walk from the start block, this numbered them by their position
  // in `workflow.nodes`, and a graph is very often not drawn in the order it
  // runs. Both carried the id, so a report was never about the wrong block —
  // but "step 1" in the prompt and the first entry in the list the agent was
  // told to report against could be two different steps (ANT-101).
  return executableBlocks(workflow).map((node) => ({ id: node.id, name: node.name }));
}

export function buildBootstrapPrompt(
  workflow: Workflow,
  marker: RunMarker,
  options: BootstrapOptions = {},
): BootstrapResult {
  const compiled = compile(workflow);
  const sections: string[] = [renderMarker(marker)];

  if (compiled.files.length > 0) {
    // The files are still worth writing — they make the roles durable for any
    // later session started in this repository. What the prompt must not do is
    // promise they work *here*: a harness's list of callable agents is fixed
    // when its session starts, so a file created mid-session is not callable in
    // that session. The first cut promised exactly that, and the delegation
    // failed with "agent not found" — after which the harness quietly
    // substituted a generic agent, which is the worst of both worlds: the page
    // showed the designed agent while something else did the work.
    sections.push(
      [
        "## Set-up: create these files first",
        "",
        "Before doing any of the work below, create these files exactly as given.",
        "They define the agents the workflow refers to. Do not change their contents.",
        "",
        "Your own list of callable agents was fixed when this session started, so the",
        "files you create now may not be callable here — they are for later sessions",
        "in this repository. Where a step below says to delegate to one of these",
        "agents and your harness does not recognise it, do not substitute a different",
        "agent. Carry the step out yourself, following that agent's file above as if",
        "you were it, and say plainly that you did so.",
      ].join("\n"),
    );
    for (const file of compiled.files) {
      sections.push([`### \`${file.path}\``, "", "```markdown", file.content.trimEnd(), "```"].join("\n"));
    }
  } else {
    // Codex has no subagent files; every role is already inline in the workflow.
    sections.push(
      [
        "## Set-up",
        "",
        "Nothing to create. Every agent this workflow refers to is described inline below.",
      ].join("\n"),
    );
  }

  sections.push(
    options.reportViaCli
      ? cliInstruction(marker, workflowSteps(workflow))
      : echoInstruction(marker, workflowSteps(workflow)),
  );
  sections.push("---");
  sections.push(compiled.prompt.trimEnd());

  return { ...compiled, marker, bootstrapPrompt: sections.join("\n\n") };
}
