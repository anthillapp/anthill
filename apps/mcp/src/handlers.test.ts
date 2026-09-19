/**
 * What the four tools answer, and what the model is told.
 *
 * The handlers are built against a real temporary exchange and called directly,
 * because every interesting case here is about what a second call sees after the
 * first one wrote something — a retried handover, a revision the user has since
 * edited past, a gate that has not been opened. A mocked store would let these
 * tests agree with this file rather than with the store the app reads.
 *
 * Two things are asserted about every result, because between them they are the
 * contract this layer exists to keep: the outcome is a value rather than a
 * thrown error, and the text block says something a model could act on. A result
 * carrying a correct `structuredContent` and an empty `content` reaches the
 * conversation looking as though the call did nothing.
 */

import { ExchangeStore, type InboxDrop } from "@anthill/exchange-store";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHandlers,
  MAX_SUBMISSION_BYTES,
  MCP_PROBLEM_CODES,
  type CreateDraftInput,
  type Handlers,
} from "./handlers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A clock that moves a second at a time, so two records never share a timestamp. */
function ticking(from = Date.parse("2026-09-18T09:00:00.000Z")): () => string {
  let at = from;
  return () => {
    at += 1000;
    return new Date(at).toISOString();
  };
}

async function openStore(): Promise<ExchangeStore> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-mcp-"));
  roots.push(dir);
  return new ExchangeStore(dir, ticking());
}

async function openTools(): Promise<{ handlers: Handlers; store: ExchangeStore }> {
  const store = await openStore();
  let minted = 0;
  return {
    store,
    handlers: createHandlers({
      store,
      mintRunId: () => `ANT-RUN${(minted += 1)}`,
      mintNonce: () => `n${minted}`,
    }),
  };
}

function completeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    target: "claude-code",
    brief: {
      goal: "The startup crash is fixed and covered by a test.",
      doneCriteria: ["The test suite passes."],
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      {
        id: "step-1",
        type: "agent",
        name: "Fix it",
        config: {
          actionKind: "implement",
          task: "Find the cause of the startup crash and fix it.",
          agentId: "agent-1",
          expectedOutput: "A patch, and a test that fails without it.",
          successCriteria: ["The new test fails on the old code."],
        },
      },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "edge-1", source: "start", target: "step-1" },
      { id: "edge-2", source: "step-1", target: "end" },
    ],
    metadata: {
      workflow: {
        agents: [{ id: "agent-1", name: "Developer", models: { "claude-code": { id: "sonnet" } } }],
      },
    },
    ...overrides,
  };
}

function draftInput(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    idempotencyKey: "handover-7",
    mode: "show-and-go",
    source: {
      harness: "claude-code",
      sessionId: "session-abc",
      taskText: "Fix the crash on startup.",
    },
    workflow: completeWorkflow(),
    ...overrides,
  };
}

/** The `structuredContent` a handler answered with, which is its whole answer. */
function answerOf(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** The text block the model reads. Never empty, on any path. */
function textOf(result: { content?: unknown[]; structuredContent?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  const text = blocks.find((block) => block.type === "text")?.text ?? "";
  expect(text.trim().length).toBeGreaterThan(0);
  return text;
}

function problemCodes(answer: Record<string, unknown>): string[] {
  return ((answer.problems ?? []) as { code: string }[]).map((problem) => problem.code);
}

async function inbox(store: ExchangeStore): Promise<InboxDrop[]> {
  return (await store.listInbox()).drops;
}

describe("create_workflow_draft", () => {
  it("stores a complete handover and asks the app to open it", async () => {
    const { handlers, store } = await openTools();

    const result = await handlers.createWorkflowDraft(draftInput());
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("created");
    expect(answer.workflowId).toBe("workflow-1");
    expect(answer.revision).toBe(1);
    expect(answer.url).toBe("anthill://workflow/workflow-1");
    expect(answer.displayed).toBe(true);

    const drops = await inbox(store);
    expect(drops).toHaveLength(1);
    expect(drops[0].kind).toBe("display");
    expect(drops[0].workflowId).toBe("workflow-1");
    expect(drops[0].revision).toBe(1);

    expect(textOf(result)).toContain("anthill://workflow/workflow-1");
  });

  it("recognises the same handover arriving twice and opens nothing twice", async () => {
    const { handlers, store } = await openTools();

    await handlers.createWorkflowDraft(draftInput());
    const again = await handlers.createWorkflowDraft(draftInput());
    const answer = answerOf(again);

    expect(answer.outcome).toBe("already_exists");
    expect(answer.revision).toBe(1);
    expect(await inbox(store)).toHaveLength(1);

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.revisions).toEqual([1]);
  });

  it("stores an incomplete draft and returns the questions to put to the user", async () => {
    const { handlers, store } = await openTools();

    const incomplete = completeWorkflow({ brief: { goal: "Make it better." } });
    const result = await handlers.createWorkflowDraft(draftInput({ workflow: incomplete }));
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("incomplete");
    expect(answer.revision).toBe(1);
    expect(problemCodes(answer)).toContain("HANDOVER_NO_DONE_CRITERIA");

    const questions = answer.questions as string[];
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) expect(textOf(result)).toContain(question);

    // Stored, not refused: the user answers the questions by reading the thing,
    // and a draft nobody can open is a draft nobody can fix.
    expect(await store.readRevision("workflow-1", 1)).toBeDefined();
    expect(await inbox(store)).toHaveLength(1);
  });

  it("refuses a handover that cannot be read, and stores nothing", async () => {
    const { handlers, store } = await openTools();

    const result = await handlers.createWorkflowDraft(
      draftInput({ mode: "whenever-you-like", source: { harness: "borg" } }),
    );
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("invalid");
    // Every problem at once rather than the first one: a sender that discovers
    // its mistakes one round trip at a time puts four questions to the user
    // where one would have done.
    expect(problemCodes(answer)).toEqual(
      expect.arrayContaining([
        "SUBMISSION_FIELD_INVALID",
        "SUBMISSION_FIELD_MISSING",
      ]),
    );
    expect(await store.readWorkflow("workflow-1")).toBeUndefined();
    expect(await inbox(store)).toHaveLength(0);
  });

  it("refuses a submission from a newer exchange by number", async () => {
    const { handlers } = await openTools();

    const answer = answerOf(
      await handlers.createWorkflowDraft(draftInput({ exchangeVersion: 99 })),
    );

    expect(answer.outcome).toBe("invalid");
    expect(problemCodes(answer)).toEqual(["EXCHANGE_VERSION_UNSUPPORTED"]);
  });

  it("refuses a handover too large to answer about, rather than storing it", async () => {
    const { handlers, store } = await openTools();

    const huge = completeWorkflow({ description: "x".repeat(MAX_SUBMISSION_BYTES + 1) });
    const result = await handlers.createWorkflowDraft(draftInput({ workflow: huge }));
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("invalid");
    expect(problemCodes(answer)).toEqual([MCP_PROBLEM_CODES.SUBMISSION_TOO_LARGE]);
    expect(await store.readWorkflow("workflow-1")).toBeUndefined();
  });

  it("opens the second workflow when one key is reused under a different id", async () => {
    const { handlers, store } = await openTools();

    // Nothing refuses this: a submission is filed under the id its document
    // carries, and the key is only compared when two of them land on one id.
    // So both are stored, and both have to be shown — a display request keyed
    // on the idempotency key alone would have collided with the first and been
    // dropped as a conflict, leaving a workflow nobody was ever shown.
    await handlers.createWorkflowDraft(draftInput());
    const second = answerOf(
      await handlers.createWorkflowDraft(
        draftInput({ workflow: completeWorkflow({ id: "workflow-2" }) }),
      ),
    );

    expect(second.outcome).toBe("created");
    expect(second.workflowId).toBe("workflow-2");
    expect(second.displayed).toBe(true);

    const drops = await inbox(store);
    expect(drops.map((drop) => drop.workflowId)).toEqual(["workflow-1", "workflow-2"]);
  });

  it("keeps two display requests apart when the ids are longer than a file name", async () => {
    const { handlers, store } = await openTools();

    // Distinct workflows, distinct directories, and one inbox file between
    // them until the key is hashed: `safeSegment` cuts a name to 120
    // characters, and everything that tells these two apart lives past it.
    const first = `${"x".repeat(112)}a`;
    const second = `${"x".repeat(112)}b`;

    await handlers.createWorkflowDraft(
      draftInput({ workflow: completeWorkflow({ id: first }) }),
    );
    // Consumed, which is the case that used to answer `already_dropped`: a
    // drop in `done/` is read as this same request having been carried out.
    await store.consumeInbox((await inbox(store))[0].key);

    const answer = answerOf(
      await handlers.createWorkflowDraft(
        draftInput({ workflow: completeWorkflow({ id: second }) }),
      ),
    );

    expect(answer.displayed).toBe(true);
    expect((await inbox(store)).map((drop) => drop.workflowId)).toEqual([second]);
  });

  it("refuses a second, unrelated workflow that claims an id already taken", async () => {
    const { handlers } = await openTools();

    await handlers.createWorkflowDraft(draftInput());
    const answer = answerOf(
      await handlers.createWorkflowDraft(
        draftInput({ idempotencyKey: "handover-8", workflow: completeWorkflow({ name: "Other" }) }),
      ),
    );

    expect(answer.outcome).toBe("invalid");
    expect(problemCodes(answer)).toEqual(["STORE_WORKFLOW_ID_TAKEN"]);
    // The one refusal here a person can answer, so it arrives as a question.
    expect((answer.questions as string[]).length).toBe(1);

    // And no link. The id resolves to the workflow that already holds the
    // name, so offering one would open somebody else's work.
    expect(answer.url).toBeUndefined();
  });
});

describe("get_workflow", () => {
  it("says so plainly when nothing of that id has been handed over", async () => {
    const { handlers } = await openTools();

    const result = await handlers.getWorkflow({ workflowId: "nothing-here" });

    expect(result.isError).toBeUndefined();
    expect(answerOf(result).outcome).toBe("not_found");
    expect(textOf(result)).toContain("create_workflow_draft");

    // Nothing of that id is stored, so there is nothing for a link to open.
    expect(answerOf(result).url).toBeUndefined();
    expect(textOf(result)).not.toContain("anthill://");
  });

  it("reports identity, head, readiness, bindings and mode", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));
    await store.markReady("workflow-1", 1);
    await handlers.bindRun({ workflowId: "workflow-1" });

    const answer = answerOf(await handlers.getWorkflow({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("found");
    expect(answer.mode).toBe("approval-gate");
    expect(answer.source).toMatchObject({ harness: "claude-code", sessionId: "session-abc" });
    expect(answer.head).toMatchObject({ revision: 1, by: "harness" });
    expect(answer.revisions).toEqual([1]);
    expect(answer.ready).toMatchObject({ revision: 1 });
    expect(answer.bindings).toHaveLength(1);
    expect(answer.eligible).toBe(true);
    expect(answer.state).toBe("bound");
  });
});

describe("get_ready_revision", () => {
  it("returns the head revision and its content under show-and-go", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.getReadyRevision({ workflowId: "workflow-1" });
    const answer = answerOf(result);

    expect(answer.outcome).toBe("ready");
    expect(answer.revision).toBe(1);
    expect(answer.mode).toBe("show-and-go");
    expect((answer.workflow as Workflow).name).toBe("Ship the fix");
    expect(answer.steps).toEqual([{ id: "step-1", name: "Fix it" }]);
    expect(textOf(result)).toContain("bind_run");
  });

  it("holds the gate shut until the user approves, and never waits", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));

    const waiting = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));
    expect(waiting.outcome).toBe("not_ready");
    expect(waiting.reason).toBe("awaiting_approval");

    await store.markReady("workflow-1", 1);

    const opened = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));
    expect(opened.outcome).toBe("ready");
    expect(opened.revision).toBe(1);
    expect(opened.state).toBe("ready_for_agent");
  });

  it("returns the revision the user approved, not the one they have since written", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));
    await store.markReady("workflow-1", 1);
    await store.addRevision("workflow-1", completeWorkflow({ name: "Renamed" }), "user");

    const answer = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("ready");
    expect(answer.revision).toBe(1);
    expect((answer.workflow as Workflow).name).toBe("Ship the fix");
  });

  it("says the workflow is not there rather than telling the caller to wait for it", async () => {
    const { handlers } = await openTools();

    const result = await handlers.getReadyRevision({ workflowId: "never-handed-over" });
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("no_such_workflow");

    // The waiting paragraph belongs to the refusals a user can clear. Told to
    // finish the turn and ask again, a caller waits for a user who has nothing
    // in front of them to approve.
    expect(textOf(result)).not.toContain("call get_ready_revision again");
    expect(textOf(result)).toContain("create_workflow_draft");
    expect(answer.url).toBeUndefined();
  });

  it("tells the caller to come back where the user is the one who can open the gate", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));

    const waiting = await handlers.getReadyRevision({ workflowId: "workflow-1" });

    expect(answerOf(waiting).outcome).toBe("not_ready");
    expect(textOf(waiting)).toContain("call get_ready_revision again");
    expect(textOf(waiting)).toContain("anthill://workflow/workflow-1");
  });

  it("carries the questions when the revision is not fit to be handed over", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(
      draftInput({ workflow: completeWorkflow({ brief: { goal: "Make it better." } }) }),
    );

    const result = await handlers.getReadyRevision({ workflowId: "workflow-1" });
    const answer = answerOf(result);

    expect(answer.outcome).toBe("not_ready");
    expect(answer.reason).toBe("incomplete");
    for (const question of answer.questions as string[]) {
      expect(textOf(result)).toContain(question);
    }
  });
});

describe("bind_run", () => {
  it("mints a run, binds it, asks the app to register it, and returns the commands", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.bindRun({ workflowId: "workflow-1" });
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("bound");
    expect(answer.runId).toBe("ANT-RUN1");
    expect(answer.nonce).toBe("n1");
    expect(answer.revision).toBe(1);
    expect(answer.registered).toBe(true);

    // The session the handover came from, so a run that goes quiet can still be
    // picked back up — the report channel never supplies one.
    expect(answer.sessionId).toBe("session-abc");

    const binding = await store.readBinding("workflow-1", "ANT-RUN1");
    expect(binding).toMatchObject({ runId: "ANT-RUN1", revision: 1, nonce: "n1" });

    const drops = await inbox(store);
    expect(drops.map((drop) => drop.kind)).toEqual(["display", "bind"]);
    expect(drops[1].runId).toBe("ANT-RUN1");

    // The commands are the only progress channel there is, so they have to
    // arrive spelled out rather than described.
    const commands = answer.reportingCommands as string;
    expect(commands).toContain("anthill run ANT-RUN1 n1");
    expect(commands).toContain("anthill step ANT-RUN1 n1");
    expect(commands).toContain("anthill done ANT-RUN1 n1");
    expect(commands).toContain("step-1");
    expect(textOf(result)).toContain("anthill run ANT-RUN1 n1");
  });

  it("refuses to bind behind a gate the user has not opened, and creates nothing", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));

    const answer = answerOf(await handlers.bindRun({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("not_ready");
    expect(answer.reason).toBe("awaiting_approval");
    expect(answer.runId).toBeUndefined();

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.bindings).toEqual([]);
    expect((await inbox(store)).map((drop) => drop.kind)).toEqual(["display"]);
  });

  it("refuses a revision the user has edited past, and names both numbers", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Renamed" }), "user");

    const result = await handlers.bindRun({ workflowId: "workflow-1", revision: 1 });
    const answer = answerOf(result);

    expect(answer.outcome).toBe("not_ready");
    expect(problemCodes(answer)).toEqual(["STORE_REVISION_NOT_ELIGIBLE"]);
    expect(textOf(result)).toContain("2");
  });

  it("says so, rather than throwing, when the workflow is not there at all", async () => {
    const { handlers } = await openTools();

    const result = await handlers.bindRun({ workflowId: "never-handed-over" });

    expect(result.isError).toBeUndefined();
    expect(answerOf(result).outcome).toBe("no_such_workflow");
    expect(answerOf(result).url).toBeUndefined();
  });

  it("refuses a session id it could not carry, and creates no run", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.bindRun({
      workflowId: "workflow-1",
      sessionId: "../../etc/passwd",
    });
    const answer = answerOf(result);

    // The refusal reaches the sender, which is the only party that can send a
    // different one. Registered as a run's session, this would be compared
    // against the ids in the harness's own files and match nothing, and the
    // run would look like one that was never observed.
    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("invalid");
    expect(problemCodes(answer)).toEqual(["SUBMISSION_FIELD_INVALID"]);
    expect(textOf(result)).toContain("sessionId");

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.bindings).toEqual([]);
    expect((await inbox(store)).map((drop) => drop.kind)).toEqual(["display"]);
  });

  it("takes a session id from the shape the harnesses actually mint", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const answer = answerOf(
      await handlers.bindRun({
        workflowId: "workflow-1",
        sessionId: "0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94",
      }),
    );

    expect(answer.outcome).toBe("bound");
    expect(answer.sessionId).toBe("0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94");
  });

  it("mints a second run rather than handing back the first", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const first = answerOf(await handlers.bindRun({ workflowId: "workflow-1" }));
    const second = answerOf(await handlers.bindRun({ workflowId: "workflow-1" }));

    expect(first.runId).toBe("ANT-RUN1");
    expect(second.runId).toBe("ANT-RUN2");
    expect(second.outcome).toBe("bound");

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.bindings.map((binding) => binding.runId).sort()).toEqual([
      "ANT-RUN1",
      "ANT-RUN2",
    ]);
  });
});

describe("workflow ids that arrived from somewhere else", () => {
  it("cannot escape the exchange, and the link survives the round trip", async () => {
    const { handlers, store } = await openTools();

    const answer = answerOf(
      await handlers.createWorkflowDraft(
        draftInput({ workflow: completeWorkflow({ id: "../../etc/passwd" }) }),
      ),
    );

    expect(answer.outcome).toBe("created");
    expect(answer.url).toBe("anthill://workflow/..%2F..%2Fetc%2Fpasswd");

    // Whatever the directory ended up being called, it is inside the exchange.
    expect(store.workingCopyPath("../../etc/passwd").startsWith(store.root)).toBe(true);

    const found = answerOf(await handlers.getWorkflow({ workflowId: "../../etc/passwd" }));
    expect(found.outcome).toBe("found");
  });
});
