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
import { revisionDigest, WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHandlers,
  MAX_BIND_KEY_LENGTH,
  MAX_SUBMISSION_BYTES,
  MCP_PROBLEM_CODES,
  type CreateDraftInput,
  type Handlers,
  type BindRunInput,
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
        formatVersion: WORKFLOW_FORMAT_VERSION,
        agents: [{ id: "agent-1", name: "Developer", models: { "claude-code": { id: "sonnet" } } }],
      },
    },
    ...overrides,
  };
}

/**
 * Five steps, none of them finished, and five different blocks to ask about.
 *
 * Every step carries everything but its task, so the only thing wrong with
 * this workflow is the same thing five times over — which is the case a list
 * of questions keyed on the question alone collapses into one.
 */
function fiveUnfinishedSteps(overrides: Partial<Workflow> = {}): Workflow {
  const names = ["Investigate", "Fix it", "Cover it", "Review it", "Ship it"];
  return completeWorkflow({
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      ...names.map((name, index) => ({
        id: `step-${index + 1}`,
        type: "agent" as const,
        name,
        config: {
          actionKind: "implement",
          task: "",
          agentId: "agent-1",
          expectedOutput: "A patch, and a test that fails without it.",
          successCriteria: ["The new test fails on the old code."],
        },
      })),
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "edge-0", source: "start", target: "step-1" },
      ...names.map((_, index) => ({
        id: `edge-${index + 1}`,
        source: `step-${index + 1}`,
        target: index + 1 < names.length ? `step-${index + 2}` : "end",
      })),
    ],
    ...overrides,
  });
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

function bindInput(overrides: Partial<BindRunInput> = {}): BindRunInput {
  return { workflowId: "workflow-1", revision: 1, digest: revisionDigest(completeWorkflow()),
    idempotencyKey: "bind-1", ...overrides };
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

/** Which values a refusal says have to change, in the order it names them. */
function problemFields(answer: Record<string, unknown>): (string | undefined)[] {
  return ((answer.problems ?? []) as { field?: string }[]).map((problem) => problem.field);
}

async function inbox(store: ExchangeStore): Promise<InboxDrop[]> {
  return (await store.listInbox()).drops;
}

describe("create_workflow_draft", () => {
  it("keeps long workflow IDs and shared sender keys in separate inbox requests", async () => {
    const { handlers, store } = await openTools();
    for (const suffix of ["a", "b"]) {
      const result = await handlers.createWorkflowDraft(draftInput({
        workflow: completeWorkflow({ id: `${"w".repeat(110)}${suffix}` }),
      }));
      expect(answerOf(result).outcome).toBe("created");
      expect(answerOf(result).displayRequested).toBe(true);
    }
    expect(await inbox(store)).toHaveLength(2);
  });
  it("stores a complete handover and asks the app to open it", async () => {
    const { handlers, store } = await openTools();

    const result = await handlers.createWorkflowDraft(draftInput());
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("created");
    expect(answer.workflowId).toBe("workflow-1");
    expect(answer.revision).toBe(1);
    expect(answer.url).toBe("anthill://workflow/workflow-1");
    expect(answer.displayed).toBe(false);
    expect(answer.displayRequested).toBe(true);
    expect(textOf(result)).toContain("not acknowledged");

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

  it("refuses an incomplete draft without reserving its id and accepts the correction", async () => {
    const { handlers, store } = await openTools();

    const incomplete = completeWorkflow({ brief: { goal: "Make it better." } });
    const result = await handlers.createWorkflowDraft(draftInput({ workflow: incomplete }));
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("incomplete");
    expect(answer.revision).toBeUndefined();
    expect(problemCodes(answer)).toContain("HANDOVER_NO_DONE_CRITERIA");

    const questions = answer.questions as string[];
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) expect(textOf(result)).toContain(question);

    expect(await store.readRevision("workflow-1", 1)).toBeUndefined();
    expect(await inbox(store)).toHaveLength(0);
    expect(answerOf(await handlers.createWorkflowDraft(draftInput())).outcome).toBe("created");
  });

  it("asks about every unfinished block by name, not once for all five", async () => {
    const { handlers } = await openTools();

    const result = await handlers.createWorkflowDraft(
      draftInput({ workflow: fiveUnfinishedSteps() }),
    );
    const answer = answerOf(result);
    const questions = answer.questions as string[];

    // One question per block. Keyed on the sentence alone, the model was
    // handed a single "What exactly should this step do?" and asked to put it
    // to the user, who had five steps and no way to tell which was meant.
    expect(answer.outcome).toBe("incomplete");
    expect(questions).toHaveLength(5);
    for (const name of ["Investigate", "Fix it", "Cover it", "Review it", "Ship it"]) {
      expect(questions.filter((question) => question.startsWith(`${name}: `))).toHaveLength(1);
    }
    for (const question of questions) expect(textOf(result)).toContain(question);
  });

  it("still asks a question about the workflow itself only once", async () => {
    const { handlers } = await openTools();

    const answer = answerOf(
      await handlers.createWorkflowDraft(
        draftInput({
          workflow: fiveUnfinishedSteps({ brief: { doneCriteria: ["The suite passes."] } }),
        }),
      ),
    );
    const questions = answer.questions as string[];

    // The missing goal belongs to no block, and five steps reading from it is
    // still one question.
    const goal = questions.filter((question) => question.includes("What is this work for?"));
    expect(goal).toHaveLength(1);
    expect(goal[0]).toBe(goal[0].trim());
    expect(questions).toHaveLength(6);
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

  it("queues the second workflow when one key is reused under a different id", async () => {
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
    expect(second.displayed).toBe(false);
    expect(second.displayRequested).toBe(true);

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

    expect(answer.displayed).toBe(false);
    expect(answer.displayRequested).toBe(true);
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

  it("reports identity, head, bindings and mode", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));
    await handlers.bindRun(bindInput());

    const answer = answerOf(await handlers.getWorkflow({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("found");
    expect(answer.mode).toBe("approval-gate");
    expect(answer.source).toMatchObject({ harness: "claude-code", sessionId: "session-abc" });
    expect(answer.head).toMatchObject({ revision: 1, by: "harness" });
    expect(answer.revisions).toEqual([1]);
    expect(answer.bindings).toHaveLength(1);
    expect(answer.eligible).toBe(true);
    expect(answer.state).toBe("bound");
  });
});

describe("get_ready_revision", () => {
  it("puts the exact edited workflow, not only labels, in model-visible text", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    const edited = completeWorkflow();
    edited.nodes[1].config.task = "Read the new task from this exact edited revision.";
    edited.brief = { ...edited.brief, constraints: ["Do not publish anything."] };
    await store.addRevision("workflow-1", edited, "user");
    const result = await handlers.getReadyRevision({ workflowId: "workflow-1" });
    expect(answerOf(result).workflow).toEqual(edited);
    expect(textOf(result)).toContain(JSON.stringify(edited));
  });
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

  // `approval-gate` is metadata a stored handover may still carry. It used to
  // hold this answer back until the user had approved something; nothing can
  // record an approval now, so a handover carrying it is workable like any
  // other rather than waiting for ever.
  it("does not wait for an approval when a handover still says approval-gate", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));

    const answer = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("ready");
    expect(answer.revision).toBe(1);
    expect(answer.state).toBe("ready_for_agent");
  });

  // The user edits, and what comes back is what they are looking at. Under the
  // gate this answered with the revision they had approved instead, which was
  // the older one the moment they touched anything.
  it("returns what the user has written, not what the harness submitted", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Renamed" }), "user");

    const answer = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));

    expect(answer.outcome).toBe("ready");
    expect(answer.revision).toBe(2);
    expect((answer.workflow as Workflow).name).toBe("Renamed");
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

  // One refusal is still the user's to clear, and it is about the graph rather
  // than about permission: questions nobody has answered. The caller is told to
  // come back, and given the link to the thing the user has to look at.
  it("tells the caller to come back where the user is the one who can clear it", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ brief: { goal: "Make it better." } }), "user");

    const waiting = await handlers.getReadyRevision({ workflowId: "workflow-1" });

    expect(answerOf(waiting).outcome).toBe("not_ready");
    expect(textOf(waiting)).toContain("call get_ready_revision again");
    expect(textOf(waiting)).toContain("anthill://workflow/workflow-1");
  });

  it("carries the questions when the revision is not fit to be handed over", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ brief: { goal: "Make it better." } }), "user");

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
  it("requires exact revision, digest and a stable binding key", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    for (const omit of ["revision", "digest", "idempotencyKey"] as const) {
      const result = await handlers.bindRun({ ...bindInput(), [omit]: undefined });
      expect(answerOf(result).outcome).toBe("invalid");
    }
    expect((await store.readWorkflow("workflow-1"))?.bindings).toHaveLength(0);
  });

  it("names the one value that has to change, and says whether it arrived", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    // A refusal that listed all three preconditions whichever one was wrong
    // was an explicit outcome and still unusable: the caller has to change
    // exactly one value and was told nothing about which, so the two it had
    // got right were as likely to be rewritten as the one it had got wrong.
    for (const [field, wrong, absent] of [
      ["revision", { revision: 0 }, false],
      ["revision", { revision: undefined }, true],
      ["digest", { digest: 42 }, false],
      ["digest", { digest: undefined }, true],
      ["idempotencyKey", { idempotencyKey: "k".repeat(MAX_BIND_KEY_LENGTH + 1) }, false],
      ["idempotencyKey", { idempotencyKey: undefined }, true],
    ] as const) {
      const where = JSON.stringify(wrong);
      const result = await handlers.bindRun({ ...bindInput(), ...wrong });
      const answer = answerOf(result);

      expect(answer.outcome, where).toBe("invalid");
      expect(problemFields(answer), where).toEqual([field]);
      expect(problemCodes(answer), where).toEqual([
        absent ? "SUBMISSION_FIELD_MISSING" : "SUBMISSION_FIELD_INVALID",
      ]);
      expect(textOf(result), where).toContain(field);
    }

    expect((await store.readWorkflow("workflow-1"))?.bindings).toHaveLength(0);
  });

  it("names every value that has to change when more than one does", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.bindRun({
      workflowId: "workflow-1", revision: "1", digest: "", idempotencyKey: "  ", sessionId: 7,
    });

    // One pass over the arguments rather than one refusal per call: a caller
    // told about `revision` alone would correct it, bind again, and be told
    // about `digest`.
    expect(problemFields(answerOf(result))).toEqual([
      "sessionId", "revision", "digest", "idempotencyKey",
    ]);
    expect((await store.readWorkflow("workflow-1"))?.bindings).toHaveLength(0);
  });

  it("names a bad id beside the values sent with it, in one answer", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    // The id used to be answered first and on its own, in the shape the two
    // read-only tools share, before the other four were looked at: a call
    // wrong in the id and in the digest was corrected over two round trips and
    // two shapes of prose, which is exactly what the one-pass check exists to
    // stop.
    const result = await handlers.bindRun({ ...bindInput(), workflowId: "   ", digest: "" });
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("invalid");
    expect(problemFields(answer)).toEqual(["workflowId", "digest"]);
    expect(textOf(result)).toContain("Nothing was bound and no run was created");
    // Nothing to name and nothing to open when the id is what was wrong; named
    // when there is one, so a caller correcting four values can see which
    // handover they were correcting them for.
    expect(answer.workflowId).toBeUndefined();
    expect(answer.url).toBeUndefined();
    expect(answerOf(await handlers.bindRun({ ...bindInput(), digest: "" })).workflowId).toBe("workflow-1");

    expect((await store.readWorkflow("workflow-1"))?.bindings).toEqual([]);
  });

  it("answers for a field of the wrong kind rather than leaving it to the schema", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    // Each of these used to be refused by the tool's input schema, which the
    // SDK validates inside the try block that turns everything into
    // `isError: true` — so a caller got a zod sentence and no outcome, and the
    // refusal written for exactly this never ran.
    for (const malformed of [
      { revision: 0 }, { revision: "1" }, { revision: 1.5 }, { digest: "" }, { digest: 7 },
      { idempotencyKey: "   " }, { idempotencyKey: "k".repeat(257) }, { sessionId: 7 },
    ]) {
      const where = JSON.stringify(malformed);
      const result = await handlers.bindRun({ ...bindInput(), ...malformed });
      expect(result.isError, where).toBeUndefined();
      expect(answerOf(result).outcome, where).toBe("invalid");
      expect(textOf(result).length, where).toBeGreaterThan(0);
    }
    expect((await store.readWorkflow("workflow-1"))?.bindings).toHaveLength(0);
  });

  it("shows the way on when a binding key has already been spent", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    const first = answerOf(await handlers.bindRun(bindInput()));

    // A harness that restarted: it repeats the key it was told to repeat, from
    // a session with a new id, and the run it is trying to rejoin is already
    // on disk. Refused — but not into a dead end.
    const again = await handlers.bindRun(bindInput({ sessionId: "session-restarted" }));

    expect(answerOf(again).outcome).toBe("conflict");
    expect(textOf(again)).toContain("Use a new idempotencyKey for a deliberate new run");
    expect(textOf(again)).toContain("get_workflow");
    expect((await store.readWorkflow("workflow-1"))?.bindings).toHaveLength(1);

    // And what get_workflow then has to say: both halves of what the reporting
    // commands take, not just the run id.
    expect(textOf(await handlers.getWorkflow({ workflowId: "workflow-1" }))).toContain(
      `${first.runId} (nonce ${first.nonce})`,
    );
  });

  it("returns the committed binding after restart and a later edit, refusing key reuse", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    const first = answerOf(await handlers.bindRun(bindInput()));
    await store.addRevision("workflow-1", completeWorkflow({ name: "Edited afterward" }), "user");
    const restarted = createHandlers({ store, mintRunId: () => { throw new Error("retry minted a run"); } });
    const retried = answerOf(await restarted.bindRun(bindInput()));
    expect(retried.outcome).toBe("already_bound");
    expect(retried.runId).toBe(first.runId);
    expect(retried.nonce).toBe(first.nonce);
    expect(retried.revision).toBe(1);
    expect(retried.digest).toBe(first.digest);
    expect(answerOf(await restarted.bindRun(bindInput({ sessionId: "other" }))).outcome).toBe("conflict");
    expect(answerOf(await handlers.bindRun(bindInput({ idempotencyKey: "new-stale" }))).outcome).toBe("not_ready");
  });
  it("mints a run, binds it, asks the app to register it, and returns the commands", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.bindRun(bindInput());
    const answer = answerOf(result);

    expect(result.isError).toBeUndefined();
    expect(answer.outcome).toBe("bound");
    expect(answer.runId).toBe("ANT-RUN1");
    expect(answer.nonce).toBe("n1");
    expect(answer.revision).toBe(1);
    expect(answer.registered).toBe(false);
    expect(answer.registrationRequested).toBe(true);

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

  // Nothing has to be approved first. This is the change: a handover that is
  // complete is bindable the moment it is stored, whatever `mode` it carries,
  // because the decision to start is the user's answer in the conversation and
  // was never anything this server held.
  it("binds a stored handover without an approval, whatever mode it carries", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput({ mode: "approval-gate" }));

    const answer = answerOf(await handlers.bindRun(bindInput()));

    expect(answer.outcome).toBe("bound");
    expect(answer.revision).toBe(1);

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.bindings.map((binding) => binding.revision)).toEqual([1]);
  });

  // The graph is still judged, and that refusal is not the gate under another
  // name: it says the diagram cannot be compiled into a prompt.
  it("refuses to bind a revision that does not validate, and creates nothing", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ brief: { goal: "Make it better." } }), "user");

    const answer = answerOf(await handlers.bindRun(bindInput({ revision: 2 })));

    expect(answer.outcome).toBe("not_ready");
    expect(answer.runId).toBeUndefined();

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.bindings).toEqual([]);
  });

  it("refuses a revision the user has edited past, and names both numbers", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Renamed" }), "user");

    const result = await handlers.bindRun(bindInput());
    const answer = answerOf(result);

    expect(answer.outcome).toBe("not_ready");
    expect(problemCodes(answer)).toEqual(["STORE_REVISION_NOT_ELIGIBLE"]);
    expect(textOf(result)).toContain("2");
  });

  it("says so, rather than throwing, when the workflow is not there at all", async () => {
    const { handlers } = await openTools();

    const result = await handlers.bindRun(bindInput({ workflowId: "never-handed-over" }));

    expect(result.isError).toBeUndefined();
    expect(answerOf(result).outcome).toBe("no_such_workflow");
    expect(answerOf(result).url).toBeUndefined();
  });

  it("refuses a session id it could not carry, and creates no run", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.bindRun(bindInput({ sessionId: "../../etc/passwd" }));
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
      await handlers.bindRun(bindInput({
        sessionId: "0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94",
      })),
    );

    expect(answer.outcome).toBe("bound");
    expect(answer.sessionId).toBe("0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94");
  });

  it("returns the same run on a retry and permits an explicit new run", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const first = answerOf(await handlers.bindRun(bindInput()));
    const repeated = answerOf(await handlers.bindRun(bindInput()));
    expect(repeated.outcome).toBe("already_bound");
    expect(repeated.runId).toBe(first.runId);
    const second = answerOf(await handlers.bindRun(bindInput({ idempotencyKey: "bind-2" })));

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

describe("the three tools that address a workflow by id", () => {
  it("answers for an id that did not arrive, and looks nothing up", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    // Absence used to be the one mistake these three left to the input schema,
    // which the SDK validates inside the try block that turns everything into
    // `isError: true` — so the caller that forgot the id got the same shape as
    // the caller whose server had fallen over.
    const calls: [string, (input: { workflowId?: unknown }) => Promise<unknown>][] = [
      ["get_workflow", (input) => handlers.getWorkflow(input)],
      ["get_ready_revision", (input) => handlers.getReadyRevision(input)],
      ["bind_run", (input) => handlers.bindRun({ ...bindInput(), workflowId: undefined, ...input })],
    ];

    for (const [tool, call] of calls) {
      for (const unusable of [{}, { workflowId: 42 }, { workflowId: "   " }, { workflowId: null }]) {
        const where = `${tool} ${JSON.stringify(unusable)}`;
        const result = (await call(unusable)) as {
          isError?: boolean;
          content?: unknown[];
          structuredContent?: Record<string, unknown>;
        };
        const answer = answerOf(result);

        expect(result.isError, where).toBeUndefined();
        expect(answer.outcome, where).toBe("invalid");
        expect(problemFields(answer), where).toEqual(["workflowId"]);
        expect(answer.url, where).toBeUndefined();
        expect(textOf(result), where).toContain("workflowId");
      }
    }

    // Nothing was looked up and nothing was bound: the workflow that is there
    // is untouched, and the only inbox request is the one the draft made.
    expect((await store.readWorkflow("workflow-1"))?.bindings).toEqual([]);
    expect((await inbox(store)).map((drop) => drop.kind)).toEqual(["display"]);
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

describe("revise_workflow", () => {
  it("stores a later version and asks the app to show it", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const revised = completeWorkflow({ name: "Ship the fix, carefully" });
    const result = await handlers.reviseWorkflow({ workflowId: "workflow-1", workflow: revised });

    expect(answerOf(result)).toMatchObject({ outcome: "revised", revision: 2, displayRequested: true });
    expect((await store.readRevision("workflow-1", 2))?.workflow.name).toBe("Ship the fix, carefully");
    // The user is looking at the working copy, which this server never writes;
    // without the request they would read the old graph while the store held
    // the new one.
    expect((await inbox(store)).filter((drop) => drop.revision === 2)).toHaveLength(1);
  });

  it("recognises content it already holds rather than stacking a duplicate", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const again = await handlers.reviseWorkflow({ workflowId: "workflow-1", workflow: completeWorkflow() });
    expect(answerOf(again)).toMatchObject({ outcome: "unchanged", revision: 1 });
    expect((await store.readWorkflow("workflow-1"))?.head?.revision).toBe(1);
  });

  it("leaves a bound run on the revision it bound, and says so", async () => {
    const { handlers } = await openTools();
    await handlers.createWorkflowDraft(draftInput());
    const ready = answerOf(await handlers.getReadyRevision({ workflowId: "workflow-1" }));
    await handlers.bindRun({
      workflowId: "workflow-1",
      revision: ready.revision,
      digest: ready.digest,
      idempotencyKey: "bind-1",
    });

    const result = await handlers.reviseWorkflow({
      workflowId: "workflow-1",
      workflow: completeWorkflow({ name: "A different plan" }),
    });
    expect(answerOf(result)).toMatchObject({ outcome: "revised", revision: 2, boundRevision: 1 });
    expect(textOf(result)).toContain("bound to revision 1 and stays on it");

    // And the bind still answers for what it bound, not for what was written after.
    const stands = answerOf(await handlers.getWorkflow({ workflowId: "workflow-1" }));
    expect(stands.bindings).toMatchObject([{ revision: 1 }]);
  });

  it("refuses a document whose id is not the workflow being revised", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const result = await handlers.reviseWorkflow({
      workflowId: "workflow-1",
      workflow: completeWorkflow({ id: "workflow-2" }),
    });
    expect(answerOf(result).outcome).toBe("invalid");
    expect((await store.readWorkflow("workflow-1"))?.head?.revision).toBe(1);
    expect(await store.readWorkflow("workflow-2")).toBeUndefined();
  });

  it("asks the questions rather than storing an incomplete revision", async () => {
    const { handlers, store } = await openTools();
    await handlers.createWorkflowDraft(draftInput());

    const gutted = completeWorkflow();
    const result = await handlers.reviseWorkflow({
      workflowId: "workflow-1",
      workflow: { ...gutted, brief: { ...gutted.brief, doneCriteria: [] } },
    });
    expect(answerOf(result).outcome).toBe("incomplete");
    expect(answerOf(result).questions).not.toHaveLength(0);
    expect((await store.readWorkflow("workflow-1"))?.head?.revision).toBe(1);
  });

  it("says when nothing of that id was ever handed over", async () => {
    const { handlers } = await openTools();
    const result = await handlers.reviseWorkflow({
      workflowId: "workflow-nobody-sent",
      workflow: completeWorkflow({ id: "workflow-nobody-sent" }),
    });
    expect(answerOf(result).outcome).toBe("no_such_workflow");
    expect(textOf(result)).toContain("waiting will not change it");
  });
});
