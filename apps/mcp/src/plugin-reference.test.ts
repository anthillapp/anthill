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
  { plugin: "Claude Code", path: "plugins/anthill/skills/workflow/reference/workflow-format.md", harness: "claude-code" as const },
  { plugin: "Codex", path: "plugins/anthill-cli/skills/anthill/reference/workflow-format.md", harness: "codex" as const },
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
