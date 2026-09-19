/**
 * What the store promises when two writers are awake at once.
 *
 * Most of these are not about the happy path at all. The cases worth pinning
 * down are the ones where something already exists: a handover submitted twice,
 * two processes reaching for the same revision number, a run binding to a
 * revision the user has since edited past, a revision file somebody corrupted.
 * In every one of them the question is the same — was nothing overwritten, and
 * was the caller told the truth about why.
 *
 * Everything runs in a real temporary directory, because the invariant under
 * test is a property of the filesystem rather than of this code: an exclusive
 * create is what makes two writers safe, and a mocked filesystem would let the
 * tests agree with the implementation instead of with the kernel.
 */

import { revisionDigest, type DraftSubmission } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXCHANGE_STORE_PROBLEM_CODES } from "./problems.js";
import { ExchangeStore } from "./store.js";

const roots: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-exchange-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A clock that moves a second at a time, so two records never share a timestamp. */
function ticking(from = Date.parse("2026-09-01T09:00:00.000Z")): () => string {
  let at = from;
  return () => {
    at += 1000;
    return new Date(at).toISOString();
  };
}

async function openStore(): Promise<ExchangeStore> {
  return new ExchangeStore(await dataDir(), ticking());
}

/** A workflow with nothing left to ask about, so completeness is never the reason. */
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

function submission(overrides: Partial<DraftSubmission> = {}): DraftSubmission {
  return {
    exchangeVersion: 1,
    idempotencyKey: "handover-7",
    source: {
      harness: "claude-code",
      sessionId: "session-abc",
      taskText: "Fix the crash on startup.",
    },
    mode: "show-and-go",
    workflow: completeWorkflow(),
    ...overrides,
  };
}

function codes(problems?: { code: string }[]): string[] {
  return (problems ?? []).map((problem) => problem.code);
}

describe("createWorkflow", () => {
  it("stores a handover as revision 1, under the document's own id", async () => {
    const store = await openStore();

    const created = await store.createWorkflow(submission());

    expect(created.outcome).toBe("created");
    expect(created.workflowId).toBe("workflow-1");
    expect(created.revision).toBe(1);

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.identity?.idempotencyKey).toBe("handover-7");
    expect(stored?.identity?.mode).toBe("show-and-go");
    expect(stored?.identity?.source.sessionId).toBe("session-abc");
    expect(stored?.head?.revision).toBe(1);
    expect(stored?.head?.by).toBe("harness");
    expect(stored?.head?.workflow.name).toBe("Ship the fix");
    expect(stored?.problems).toEqual([]);
  });

  it("recognises the same handover arriving twice and adds nothing", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const again = await store.createWorkflow(submission());

    expect(again.outcome).toBe("already_exists");
    expect(again.revision).toBe(1);
    expect((await store.readWorkflow("workflow-1"))?.revisions).toEqual([1]);
  });

  it("refuses the same key carrying different content, and overwrites nothing", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    const before = await store.readRevision("workflow-1", 1);

    const changed = await store.createWorkflow(
      submission({ workflow: completeWorkflow({ name: "Ship something else" }) }),
    );

    expect(changed.outcome).toBe("conflict");
    expect(codes(changed.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_IDENTITY_CONFLICT,
    ]);
    expect(changed.problems?.[0]?.message).toContain("handover-7");
    expect(await store.readRevision("workflow-1", 1)).toEqual(before);
  });

  it("refuses a second handover claiming a workflow id that is taken", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const other = await store.createWorkflow(submission({ idempotencyKey: "handover-9" }));

    expect(other.outcome).toBe("conflict");
    expect(other.problems?.[0]?.message).toContain("handover-9");
    expect((await store.readWorkflow("workflow-1"))?.identity?.idempotencyKey).toBe("handover-7");
  });

  it("refuses a submission addressed to one workflow and carrying another", async () => {
    const store = await openStore();

    const misaddressed = await store.createWorkflow(submission({ workflowId: "workflow-2" }));

    expect(misaddressed.outcome).toBe("conflict");
    expect(codes(misaddressed.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_ID_MISMATCH,
    ]);
    expect(await store.readWorkflow("workflow-1")).toBeUndefined();
  });

  it("stores an incomplete handover and says what is missing", async () => {
    const store = await openStore();
    const vague = completeWorkflow();
    delete vague.brief;

    const created = await store.createWorkflow(submission({ workflow: vague }));

    expect(created.outcome).toBe("created");
    // Stored, because the user answers these by reading the workflow, and a
    // draft nobody can open is a draft nobody can fix.
    expect(created.problems?.length).toBeGreaterThan(0);
    for (const problem of created.problems ?? []) expect(problem.ask).toBeTruthy();
    expect((await store.readWorkflow("workflow-1"))?.head?.revision).toBe(1);
  });

  it("keeps a workflow id that looks like a path inside the root", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    const escaping = completeWorkflow({ id: "../../../etc/passwd" });

    const created = await store.createWorkflow(submission({ workflow: escaping }));

    expect(created.outcome).toBe("created");
    expect(store.workingCopyPath("../../../etc/passwd").startsWith(store.root)).toBe(true);
    expect(await readdir(join(root, "exchange", "workflows"))).toEqual(["_etc_passwd"]);
    // And the workflow is still addressable by the id it was submitted with.
    expect((await store.readWorkflow("../../../etc/passwd"))?.identity?.workflowId).toBe(
      "../../../etc/passwd",
    );
  });

  it("refuses two ids that would share one directory rather than merging them", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ workflow: completeWorkflow({ id: "a/b" }) }));

    const collision = await store.createWorkflow(
      submission({ idempotencyKey: "handover-8", workflow: completeWorkflow({ id: "a:b" }) }),
    );

    expect(collision.outcome).toBe("conflict");
    expect(collision.problems?.[0]?.message).toContain("a/b");
  });
});

describe("addRevision", () => {
  it("adds a revision when the content differs from the head", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const added = await store.addRevision(
      "workflow-1",
      completeWorkflow({ name: "Ship the fix, carefully" }),
      "user",
    );

    expect(added.outcome).toBe("added");
    expect(added.revision).toBe(2);
    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.revisions).toEqual([1, 2]);
    expect(stored?.head?.by).toBe("user");
  });

  it("writes nothing when a save changed nothing", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const unchanged = await store.addRevision("workflow-1", completeWorkflow(), "user");

    expect(unchanged.outcome).toBe("unchanged");
    expect(unchanged.revision).toBe(1);
    expect((await store.readWorkflow("workflow-1"))?.revisions).toEqual([1]);
  });

  it("treats a key-order difference as the same content", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    // The same document with its top-level keys in the opposite order, which is
    // what a harness rebuilding a workflow from another code path produces.
    const reordered = Object.fromEntries(
      Object.entries(completeWorkflow()).reverse(),
    ) as unknown as Workflow;

    expect((await store.addRevision("workflow-1", reordered, "user")).outcome).toBe("unchanged");
  });

  it("refuses a revision whose document has been renamed out from under it", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const renamed = await store.addRevision(
      "workflow-1",
      completeWorkflow({ id: "workflow-2" }),
      "user",
    );

    expect(renamed.outcome).toBe("conflict");
    expect(codes(renamed.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_ID_MISMATCH,
    ]);
  });

  it("says so rather than inventing a workflow that was never handed over", async () => {
    const store = await openStore();

    const answer = await store.addRevision(
      "workflow-9",
      completeWorkflow({ id: "workflow-9" }),
      "user",
    );

    expect(answer.outcome).toBe("no_such_workflow");
  });

  it("records a revision that no longer validates, and says what is wrong with it", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    const broken = completeWorkflow();
    broken.brief = { goal: "The startup crash is fixed.", doneCriteria: [] };

    const added = await store.addRevision("workflow-1", broken, "user");

    // The user's work is recorded whatever state it is in; eligibility is where
    // an incomplete revision stops something happening.
    expect(added.outcome).toBe("added");
    expect(added.problems?.length).toBeGreaterThan(0);
  });

  it("gives two writers two distinct revisions and loses neither", async () => {
    const root = await dataDir();
    const app = new ExchangeStore(root, ticking());
    const server = new ExchangeStore(root, ticking(Date.parse("2026-09-02T09:00:00.000Z")));
    await app.createWorkflow(submission());

    const mine = completeWorkflow({ name: "The app's edit" });
    const theirs = completeWorkflow({ name: "The server's edit" });
    const [first, second] = await Promise.all([
      app.addRevision("workflow-1", mine, "user"),
      server.addRevision("workflow-1", theirs, "harness"),
    ]);

    expect(first.outcome).toBe("added");
    expect(second.outcome).toBe("added");
    expect(new Set([first.revision, second.revision])).toEqual(new Set([2, 3]));

    const stored = await app.readWorkflow("workflow-1");
    expect(stored?.revisions).toEqual([1, 2, 3]);
    const names = await Promise.all(
      [1, 2, 3].map(async (revision) => (await app.readRevision("workflow-1", revision))?.workflow.name),
    );
    expect(new Set(names)).toEqual(new Set(["Ship the fix", "The app's edit", "The server's edit"]));
  });

  it("does not write the same content twice when two writers save it at once", async () => {
    const root = await dataDir();
    const app = new ExchangeStore(root, ticking());
    const server = new ExchangeStore(root, ticking(Date.parse("2026-09-02T09:00:00.000Z")));
    await app.createWorkflow(submission());

    const both = completeWorkflow({ name: "The same second thought" });
    const results = await Promise.all([
      app.addRevision("workflow-1", both, "user"),
      server.addRevision("workflow-1", both, "harness"),
    ]);

    // One of them created revision 2 and the other found its own content
    // already there, which is not a conflict — it is the revision it wanted.
    expect(results.map((result) => result.revision)).toEqual([2, 2]);
    expect(results.filter((result) => result.outcome === "added")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "unchanged")).toHaveLength(1);
    expect((await app.readWorkflow("workflow-1"))?.revisions).toEqual([1, 2]);
  });

  it("leaves a bound revision exactly as it was when the workflow is edited", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.createWorkflow(submission());
    await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });
    const onDisk = await readFile(
      join(root, "exchange", "workflows", "workflow-1", "revisions", "0001.json"),
      "utf8",
    );

    const added = await store.addRevision(
      "workflow-1",
      completeWorkflow({ name: "Second thoughts" }),
      "user",
    );

    expect(added.revision).toBe(2);
    expect(
      await readFile(
        join(root, "exchange", "workflows", "workflow-1", "revisions", "0001.json"),
        "utf8",
      ),
    ).toBe(onDisk);
  });
});

describe("markReady", () => {
  it("records the approval of one exact revision", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));

    const ready = await store.markReady("workflow-1", 1);

    expect(ready.outcome).toBe("ready");
    expect(await store.readyRevision("workflow-1")).toBe(1);
  });

  it("keeps the first answer when the same revision is approved twice", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));
    const first = await store.markReady("workflow-1", 1);

    const again = await store.markReady("workflow-1", 1);

    expect(again.outcome).toBe("already_ready");
    expect(again.at).toBe(first.at);
  });

  it("will not approve a revision that does not exist", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));

    expect((await store.markReady("workflow-1", 4)).outcome).toBe("no_such_revision");
    expect((await store.markReady("workflow-9", 1)).outcome).toBe("no_such_workflow");
  });
});

describe("eligibleRevision", () => {
  it("makes the head revision eligible under show-and-go", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Later" }), "user");

    const eligible = await store.eligibleRevision("workflow-1");

    expect(eligible.eligible).toBe(true);
    if (eligible.eligible) {
      expect(eligible.revision.revision).toBe(2);
      expect(eligible.state).toBe("ready_for_agent");
    }
  });

  it("refuses a head revision that does not validate, with the questions attached", async () => {
    const store = await openStore();
    const vague = completeWorkflow();
    delete vague.brief;
    await store.createWorkflow(submission({ workflow: vague }));

    const eligible = await store.eligibleRevision("workflow-1");

    expect(eligible.eligible).toBe(false);
    if (!eligible.eligible) {
      expect(eligible.reason).toBe("incomplete");
      expect(eligible.problems.every((problem) => problem.ask)).toBe(true);
    }
  });

  it("waits for the user under approval-gate, and never falls back to the head", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));

    const waiting = await store.eligibleRevision("workflow-1");

    expect(waiting.eligible).toBe(false);
    if (!waiting.eligible) expect(waiting.reason).toBe("awaiting_approval");
  });

  it("does not let an approval of revision 1 carry to revision 2", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));
    await store.markReady("workflow-1", 1);
    await store.addRevision("workflow-1", completeWorkflow({ name: "Edited after approval" }), "user");

    const eligible = await store.eligibleRevision("workflow-1");

    expect(eligible.eligible).toBe(true);
    // The approval belongs to the revision the user read, not to whatever the
    // workflow has become since.
    if (eligible.eligible) expect(eligible.revision.revision).toBe(1);
    expect(await store.readyRevision("workflow-1")).toBe(1);
  });

  it("says there is no such workflow rather than answering about nothing", async () => {
    const store = await openStore();

    const eligible = await store.eligibleRevision("workflow-9");

    expect(eligible.eligible).toBe(false);
    if (!eligible.eligible) {
      expect(eligible.reason).toBe("no_such_workflow");
      expect(codes(eligible.problems)).toEqual([
        EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_UNKNOWN,
      ]);
    }
  });
});

describe("bind", () => {
  it("binds a run to the eligible revision, carrying the harness's session", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const bound = await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });

    expect(bound.outcome).toBe("bound");
    expect(bound.binding?.sessionId).toBe("session-abc");
    expect((await store.readBinding("workflow-1", "ANT-11111111"))?.revision).toBe(1);
  });

  it("recognises the same bind arriving twice", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    const first = await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });

    const again = await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });

    expect(again.outcome).toBe("already_bound");
    expect(again.binding?.at).toBe(first.binding?.at);
  });

  it("refuses to move a run to another revision, and leaves the binding alone", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });
    await store.addRevision("workflow-1", completeWorkflow({ name: "Moved on" }), "user");

    const moved = await store.bind("workflow-1", 2, { runId: "ANT-11111111", nonce: "abc123" });

    expect(moved.outcome).toBe("conflict");
    expect(codes(moved.problems)).toEqual([EXCHANGE_STORE_PROBLEM_CODES.STORE_BINDING_CONFLICT]);
    expect((await store.readBinding("workflow-1", "ANT-11111111"))?.revision).toBe(1);
  });

  it("refuses a revision the mode does not make eligible", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));
    await store.markReady("workflow-1", 1);
    await store.addRevision("workflow-1", completeWorkflow({ name: "Unapproved" }), "user");

    const early = await store.bind("workflow-1", 2, { runId: "ANT-22222222", nonce: "def456" });

    expect(early.outcome).toBe("not_eligible");
    expect(codes(early.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_NOT_ELIGIBLE,
    ]);
    expect(await store.readBinding("workflow-1", "ANT-22222222")).toBeUndefined();
  });

  it("refuses to bind anything while the gate is shut", async () => {
    const store = await openStore();
    await store.createWorkflow(submission({ mode: "approval-gate" }));

    const early = await store.bind("workflow-1", 1, { runId: "ANT-22222222", nonce: "def456" });

    expect(early.outcome).toBe("not_eligible");
    expect(codes(early.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_AWAITING_APPROVAL,
    ]);
  });

  it("calls a bound revision bound when it is asked about again", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    await store.bind("workflow-1", 1, { runId: "ANT-11111111", nonce: "abc123" });

    const eligible = await store.eligibleRevision("workflow-1");

    expect(eligible.eligible).toBe(true);
    if (eligible.eligible) expect(eligible.state).toBe("bound");
  });
});

describe("the inbox", () => {
  it("carries a request to the app and keeps a copy once it is consumed", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const dropped = await store.dropInbox({
      kind: "display",
      key: "drop-1",
      workflowId: "workflow-1",
      revision: 1,
    });
    expect(dropped.outcome).toBe("dropped");

    const waiting = await store.listInbox();
    expect(waiting.drops.map((drop) => drop.key)).toEqual(["drop-1"]);

    expect((await store.consumeInbox("drop-1")).outcome).toBe("consumed");
    expect((await store.listInbox()).drops).toEqual([]);
    // Consumed, and therefore not dropped again by a server that lost its answer.
    expect((await store.dropInbox({ kind: "display", key: "drop-1", workflowId: "workflow-1", revision: 1 })).outcome).toBe(
      "already_dropped",
    );
    expect((await store.listInbox()).drops).toEqual([]);
  });

  it("ignores a half-written file left beside a drop", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.dropInbox({ kind: "display", key: "drop-1", workflowId: "workflow-1", revision: 1 });
    await writeFile(join(root, "exchange", "inbox", "drop-2.json.4242.1.tmp"), "{\"half\":", "utf8");

    const waiting = await store.listInbox();

    expect(waiting.drops.map((drop) => drop.key)).toEqual(["drop-1"]);
    expect(waiting.damaged).toEqual([]);
  });

  it("lists a drop it cannot read rather than re-reading it for ever", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.dropInbox({ kind: "display", key: "drop-1", workflowId: "workflow-1", revision: 1 });
    await writeFile(join(root, "exchange", "inbox", "drop-2.json"), "not json at all", "utf8");

    const waiting = await store.listInbox();

    expect(waiting.drops.map((drop) => drop.key)).toEqual(["drop-1"]);
    expect(waiting.damaged.map((drop) => drop.key)).toEqual(["drop-2"]);
    expect(codes(waiting.damaged.map((drop) => drop.problem))).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    ]);
    expect((await store.consumeInbox("drop-2")).outcome).toBe("consumed");
    expect((await store.listInbox()).damaged).toEqual([]);
  });

  it("refuses a second, different request under one key", async () => {
    const store = await openStore();
    await store.dropInbox({ kind: "display", key: "drop-1", workflowId: "workflow-1", revision: 1 });

    const other = await store.dropInbox({
      kind: "display",
      key: "drop-1",
      workflowId: "workflow-2",
      revision: 1,
    });

    expect(other.outcome).toBe("conflict");
    expect(codes(other.problems)).toEqual([EXCHANGE_STORE_PROBLEM_CODES.STORE_INBOX_CONFLICT]);
    expect(other.drop?.workflowId).toBe("workflow-1");
  });

  it("says nothing was there when there was nothing to consume", async () => {
    const store = await openStore();

    expect((await store.consumeInbox("drop-9")).outcome).toBe("not_found");
  });
});

describe("damage", () => {
  it("costs one revision rather than the workflow it belongs to", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.createWorkflow(submission());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Second" }), "user");
    await writeFile(
      join(root, "exchange", "workflows", "workflow-1", "revisions", "0002.json"),
      "{ half a record",
      "utf8",
    );

    const stored = await store.readWorkflow("workflow-1");

    expect(stored?.revisions).toEqual([1, 2]);
    expect(stored?.head?.revision).toBe(1);
    expect(codes(stored?.problems)).toEqual([
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    ]);
  });

  it("does not hand a damaged revision's number to the next writer", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.createWorkflow(submission());
    await store.addRevision("workflow-1", completeWorkflow({ name: "Second" }), "user");
    const damaged = join(root, "exchange", "workflows", "workflow-1", "revisions", "0002.json");
    await writeFile(damaged, "{ half a record", "utf8");

    const added = await store.addRevision("workflow-1", completeWorkflow({ name: "Third" }), "user");

    expect(added.revision).toBe(3);
    // The damaged file is the only copy of whatever revision 2 was; writing
    // over it would make the loss permanent.
    expect(await readFile(damaged, "utf8")).toBe("{ half a record");
  });

  it("refuses a record from a newer Anthill instead of opening it", async () => {
    const root = await dataDir();
    const store = new ExchangeStore(root, ticking());
    await store.createWorkflow(submission());
    const identity = join(root, "exchange", "workflows", "workflow-1", "identity.json");
    const stored = JSON.parse(await readFile(identity, "utf8")) as Record<string, unknown>;
    await writeFile(identity, JSON.stringify({ ...stored, version: 99 }), "utf8");

    const workflow = await store.readWorkflow("workflow-1");

    expect(workflow?.identity).toBeUndefined();
    expect(codes(workflow?.problems)).toEqual([EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_TOO_NEW]);
    const eligible = await store.eligibleRevision("workflow-1");
    expect(eligible.eligible).toBe(false);
    if (!eligible.eligible) expect(eligible.reason).toBe("unreadable");
  });
});

describe("the digest", () => {
  it("is what the store writes down, so a caller need not recompute it", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    expect((await store.readRevision("workflow-1", 1))?.digest).toBe(
      revisionDigest(completeWorkflow()),
    );
  });
});
