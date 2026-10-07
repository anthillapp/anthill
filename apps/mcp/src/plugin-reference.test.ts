/**
 * The workflow document each plugin's reference shows, read as a handover.
 *
 * ANT-124. A session building its first document copies the reference's
 * example, and the example gave its agents no model — so every first handover
 * came back `incomplete` on the model question, and the session went looking
 * through the repository for how to answer it. The example now carries the
 * answer, and this keeps it carrying one.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOWNER_ADVISORY_CODES } from "@anthill/workflow";
import { checkCompleteness } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The first JSON block in a reference: its example workflow. */
function example(path: string): Workflow {
  const text = readFileSync(join(ROOT, path), "utf8");
  const block = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!block) throw new Error(`${path} has no JSON example`);
  return JSON.parse(block[1]) as Workflow;
}

describe.each([
  { plugin: "Claude Code", path: "plugins/anthill-claude/skills/workflow/reference/workflow-format.md", harness: "claude-code" as const },
  { plugin: "Codex", path: "plugins/anthill-codex/skills/anthill/reference/workflow-format.md", harness: "codex" as const },
  { plugin: "VS Code", path: "plugins/anthill-vscode/skills/workflow/reference/workflow-format.md", harness: "vscode" as const },
])("the $plugin reference", ({ path, harness }) => {
  it("shows an example whose agents already answer the model question", () => {
    const problems = checkCompleteness(example(path), { harness, sessionId: "s", taskText: "The task." });
    expect(problems.map((problem) => problem.code)).not.toContain(WORKFLOWNER_ADVISORY_CODES.AGENT_NO_MODEL_FOR_TARGET);
  });

  it("says how to write the session's own model", () => {
    const text = readFileSync(join(ROOT, path), "utf8");
    expect(text).toContain(`"models": { "${harness}": { "id": "__default__" } }`);
  });
});

/*
  ANT-224. The skill is what turns --dev in the command into build: "dev" on
  the first handover; the server never reads the chat. Both skills say when the
  word is the flag and when it is part of the task, with the same examples.
*/
describe.each([
  { plugin: "Claude Code", path: "plugins/anthill-claude/skills/workflow/SKILL.md" },
  { plugin: "Codex", path: "plugins/anthill-codex/skills/anthill/SKILL.md" },
  { plugin: "VS Code", path: "plugins/anthill-vscode/skills/workflow/SKILL.md" },
])("the $plugin skill", ({ path }) => {
  const text = () => readFileSync(join(ROOT, path), "utf8");

  it("turns --dev into build: \"dev\" on every call the command makes", () => {
    expect(text()).toContain("## Which Anthill: `--dev`");
    expect(text()).toContain('pass `build: "dev"` on **every** call');
    expect(text()).toContain("`get_workflow` or `get_ready_revision` when\npicking a `--dev` handover back up");
    expect(text()).toContain("`bind_run`, `run_workflow`, and");
  });

  // ANT-281: run "<path>" runs a saved workflow.json again, through run_workflow.
  it("runs a saved workflow again with run \"<path>\", without asking or drafting", () => {
    expect(text()).toContain("run_workflow");
    expect(text()).toMatch(/run "<path>"/);
    expect(text()).toMatch(/carry\s+out\s+the\s+prompt/);
  });

  it("covers the four cases: with and without --dev, a task about dev, and a pinned chat", () => {
    expect(text()).toContain("| `design Add retry to checkout` | Add retry to checkout | left out |");
    expect(text()).toContain('| `design --dev Add retry to checkout` | Add retry to checkout | `"dev"` |');
    expect(text()).toContain("| `design dev server for staging` | dev server for staging | left out |");
    expect(text()).toMatch(/`"dev"`, refused: tell them it takes a new (chat|task)/);
  });

  it("never lets a bare dev be the flag", () => {
    expect(text()).toContain("A bare\n`dev` is never the flag");
  });
});

/*
  A run's graph shows only the steps the agent reports. A block worked on while
  another waited on a background review was never reported, and the canvas drew
  it as skipped ("moved on on its own") although it was done. Both skills say
  every block gets its own report, parallel work included.
*/
describe.each([
  { plugin: "Claude Code", path: "plugins/anthill-claude/skills/workflow/SKILL.md" },
  { plugin: "Codex", path: "plugins/anthill-codex/skills/anthill/SKILL.md" },
  { plugin: "VS Code", path: "plugins/anthill-vscode/skills/workflow/SKILL.md" },
])("the $plugin skill's progress reports", ({ path }) => {
  const text = () => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  it("gives every block it works on its own step, parallel work included", () => {
    expect(text()).toMatch(/every block you work on gets its own/i);
    expect(text()).toMatch(/background/);
    expect(text()).toMatch(/subagent not (yet )?back|subagent not back yet/);
  });

  it("checks for a missed block before moving on, rather than jumping past it", () => {
    expect(text()).toMatch(/report(s|ing)? (it|a missed one) (now, )?before (the next|moving on)/);
  });
});
