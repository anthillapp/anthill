import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { buildBootstrapPrompt } from "./bootstrap.js";
import { parseMarker, textCarriesMarker, type RunMarker } from "./marker.js";

const marker: RunMarker = {
  runId: "ANT-1A2B3C4D",
  nonce: "9f8e7d",
  workflowId: "workflow-1",
  cli: "claude-code",
  promptVersion: "1",
  issuedAt: "2026-08-29T10:00:00.000Z",
};

/**
 * A workflow with no agent steps, which is now the only way to produce no agent
 * files. Targeting Codex used to do it, because Anthill believed Codex had no
 * custom agents; it has them, so both harnesses write files (ANT-51).
 */
function withoutAgents(target: "claude-code" | "codex"): Workflow {
  const base = workflow(target);
  return {
    ...base,
    nodes: base.nodes.filter((node) => node.id !== "read"),
    edges: [{ id: "e1", source: "start", target: "end" }],
  };
}

function workflow(target: "claude-code" | "codex"): Workflow {
  return {
    id: "workflow-1",
    name: "Read the note",
    version: "1",
    target,
    brief: {
      goal: "Read note.txt and say what it contains.",
      doneCriteria: ["The contents of note.txt have been reported."],
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      {
        id: "read",
        type: "agent",
        name: "Read the note",
        config: {
          actionKind: "agent-step",
          task: "Read note.txt in the working directory.",
          agentId: "agent-1",
        },
      },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "read" },
      { id: "e2", source: "read", target: "end", kind: "next" },
    ],
    metadata: {
      workflow: { formatVersion: 4, agents: [{ id: "agent-1", name: "Reader", role: "Reads files" }] },
    },
  };
}

describe("the copied bootstrap prompt", () => {
  it("opens with the marker, so it lands in the session's first record", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(bootstrapPrompt.startsWith("<!--")).toBe(true);
    expect(parseMarker(bootstrapPrompt)).toEqual(marker);
    expect(textCarriesMarker(bootstrapPrompt, marker)).toBe(true);
  });

  it("puts set-up before the workflow, so the session can prepare itself", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    const setup = bootstrapPrompt.indexOf("## Set-up");
    const workflow_ = bootstrapPrompt.indexOf("# Read the note");
    expect(setup).toBeGreaterThan(0);
    expect(setup).toBeLessThan(workflow_);
  });

  it("carries the agent files inline, so exporting stays optional", () => {
    const result = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(result.files.length).toBeGreaterThan(0);
    for (const file of result.files) {
      expect(result.bootstrapPrompt).toContain(file.path);
      expect(result.bootstrapPrompt).toContain(file.content.trimEnd());
    }
  });

  it("says there is nothing to create for a workflow with no agent files", () => {
    const result = buildBootstrapPrompt(withoutAgents("codex"), { ...marker, cli: "codex" });
    expect(result.files).toHaveLength(0);
    expect(result.bootstrapPrompt).toContain("Nothing to create");
    expect(result.bootstrapPrompt).toContain("described inline");
  });

  it("keeps the compiled workflow exactly as the workflow produced it", () => {
    const result = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(result.bootstrapPrompt).toContain(result.prompt.trimEnd());
  });

  it("asks the agent to echo the run marker without depending on it", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(bootstrapPrompt).toContain(`ANTHILL-RUN ${marker.runId} ${marker.nonce}`);
    expect(bootstrapPrompt).toContain("Ignore this section entirely");
  });

  it("asks for a step marker, and lists the ids it expects back", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(bootstrapPrompt).toContain(`ANTHILL-STEP ${marker.runId} ${marker.nonce} <step-id>`);
    // The ids sit next to the instruction, not several sections away: an agent
    // asked to print an id it has to hunt for usually does not print it.
    const instruction = bootstrapPrompt.indexOf("Use exactly these step ids");
    const ids = bootstrapPrompt.indexOf("`read` — Read the note");
    expect(instruction).toBeGreaterThan(0);
    expect(ids).toBeGreaterThan(instruction);
    expect(ids).toBeLessThan(bootstrapPrompt.indexOf("# Read the note"));
    // Start and end carry no work, so they are not steps anyone announces.
    expect(bootstrapPrompt).not.toContain("`start` —");
  });
});

/**
 * What the prompt promises about the files it asks for.
 *
 * From the In Review audit: a harness's list of callable agents is fixed when
 * its session starts, so a file created mid-session is not callable in that
 * session. The first cut promised it was; the delegation failed with "agent
 * not found" and the harness silently substituted a generic agent — the
 * designed agent on the page, something else doing the work.
 */
describe("the promise made about agent files", () => {
  it("says the files may not be callable in this session, and what to do instead", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(bootstrapPrompt).toContain("fixed when this session started");
    expect(bootstrapPrompt).toContain("do not substitute a different");
    expect(bootstrapPrompt).toContain("Carry the step out yourself");
  });

  it("makes no such claim for a workflow with no agent files", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(withoutAgents("codex"), marker);
    expect(bootstrapPrompt).toContain("Nothing to create");
    expect(bootstrapPrompt).not.toContain("fixed when this session started");
  });
});

/**
 * The prompt's progress channel.
 *
 * By default the harness prints marker lines; a shell that runs the Anthill
 * CLI on this machine (the Linux CLI) can instead tell the harness to call
 * it. The marker itself is unchanged either way: it is in the pasted text
 * and reaches the session file without the agent's cooperation.
 */
describe("the progress channel", () => {
  it("asks for printed marker lines by default", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker);
    expect(bootstrapPrompt).toContain(`ANTHILL-RUN ${marker.runId} ${marker.nonce}`);
    expect(bootstrapPrompt).not.toContain("anthill run");
  });

  it("instructs the harness to use the CLI when asked to", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker, { reportViaCli: true });
    expect(bootstrapPrompt).toContain(`anthill run ${marker.runId} ${marker.nonce}`);
    expect(bootstrapPrompt).toContain(`anthill step ${marker.runId} ${marker.nonce} <step-id>`);
    // The printed lines are gone, not doubled: a prompt that asked for both
    // channels would make an agent do the work twice for no benefit.
    expect(bootstrapPrompt).not.toContain("ANTHILL-RUN");
    expect(bootstrapPrompt).not.toContain("ANTHILL-STEP");
  });

  it("still carries the marker in the pasted text, either way", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker, { reportViaCli: true });
    expect(textCarriesMarker(bootstrapPrompt, marker)).toBe(true);
  });

  it("lists the step ids in the CLI instruction too", () => {
    const { bootstrapPrompt } = buildBootstrapPrompt(workflow("claude-code"), marker, { reportViaCli: true });
    expect(bootstrapPrompt).toContain("`read` — Read the note");
  });
});
