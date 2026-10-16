import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addBlock, agents, connect, createWorkflow, updateBlock } from "@anthill/api";
import { validateWorkflow } from "@anthill/workflow";

/**
 * The smoke test is the driver: it imports `@anthill/api` — the single
 * origin — and drives create → addBlock → updateBlock → connect, and the
 * result must validate (well-formed).
 */
describe("the create + edit half, driven from one import", () => {
  it("create → addBlock → updateBlock → connect, and the workflow validates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-api-"));
    process.env.ANTHILL_WORKFLOW_DIR = dir;
    try {
      // Create: a 2-step workflow with one agent.
      const created = await createWorkflow({
        goal: "Triage the inbox",
        verification: "Every message is labelled",
        doneCriteria: ["No unlabelled messages remain"],
        agents: [{ name: "Triage", role: "triage" }],
        steps: [
          { name: "Read the inbox", agent: "Triage", task: "List the unlabelled messages." },
          { name: "Label them", agent: "Triage", task: "Label each message." },
        ],
        target: "pi",
      });
      expect(validateWorkflow(created).valid).toBe(true);

      // The created workflow's agent id, so the new block can be assigned to it.
      const [triage] = await agents(created.id);
      expect(triage?.name).toBe("Triage");

      // Add a third block, beside the second step. An agent block is
      // validated on its action and its task, so the driver supplies both —
      // the app's block editor seeds the same defaults, the API stays a
      // thin re-exposure and does not guess.
      const withThird = await addBlock(created.id, {
        blockType: "agent",
        name: "Summarize",
        config: { agentId: triage?.id, actionKind: "summarize", task: "Summarize the labels." },
        near: "step-2",
      });
      expect(withThird.nodes).toHaveLength(5); // start + 2 steps + the new block + end

      // The new block's id is the one the workflow's counter issued (a
      // `block-N`, not a `step-N`) — the test reads it back rather than
      // guessing it.
      const newId = withThird.nodes.find((node) => node.name === "Summarize")?.id;
      expect(newId).toBeDefined();

      // Update it: rename, keep its config.
      const renamed = await updateBlock(created.id, newId!, { name: "Write the summary" });
      expect(renamed.nodes.find((node) => node.id === newId)?.name).toBe("Write the summary");

      // Connect it into the line: after the second step, on to the end.
      await connect(created.id, "step-2", newId!);
      const final = await connect(created.id, newId!, "end-1");

      expect(validateWorkflow(final).valid).toBe(true);
      expect(final.edges.some((edge) => edge.source === "step-2" && edge.target === newId)).toBe(true);
      expect(final.edges.some((edge) => edge.source === newId && edge.target === "end-1")).toBe(true);
    } finally {
      delete process.env.ANTHILL_WORKFLOW_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a rejected op throws and leaves the workflow on disk unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-api-"));
    process.env.ANTHILL_WORKFLOW_DIR = dir;
    try {
      const created = await createWorkflow({
        goal: "Triage the inbox",
        agents: [{ name: "Triage" }],
        steps: [{ name: "Read the inbox", agent: "Triage", task: "List the unlabelled messages." }],
        target: "pi",
      });
      const before = await readFile(join(dir, `${created.name}.workflow.json`), "utf8").catch(() => null);

      // A connection to a block that is not there is refused.
      await expect(connect(created.id, "step-1", "no-such-block")).rejects.toThrow(/no-such-block|does not exist|not there/i);

      const after = await readFile(join(dir, `${created.name}.workflow.json`), "utf8").catch(() => null);
      expect(after).toBe(before);
    } finally {
      delete process.env.ANTHILL_WORKFLOW_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
