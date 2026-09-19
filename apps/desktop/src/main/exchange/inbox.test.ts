/**
 * What the app does with what a coding harness left for it.
 *
 * The question behind nearly every case here is the same one: was the request
 * consumed, and did what it asked for actually happen? A drop in `done/` is
 * this app's word that the user saw their workflow, and it is the only record
 * there is — so an app with no window, a user who would rather keep what they
 * have open, and a revision nobody can read must each leave a different trace.
 *
 * The store is real and lives in a temporary directory, because the inbox is a
 * directory and half of what is being checked is which files are in it
 * afterwards. Only the window is a stub, because there is no window.
 */

import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION, type DraftSubmission } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WindowOperations } from "./deep-link.js";
import { ExchangeInbox, type BoundRun, type InboxEffects, type OpenOutcome, type OpenPermission } from "./inbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openStore(): Promise<ExchangeStore> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-inbox-"));
  roots.push(dir);
  return new ExchangeStore(dir);
}

/** A window that says yes to everything, and remembers what it was asked. */
function watcher(permission: OpenPermission = "yes") {
  const opened: string[] = [];
  const refused: string[] = [];
  const registered: BoundRun[] = [];
  let outcome: OpenOutcome = { kind: "shown" };
  let registerFails = false;

  const effects: InboxEffects = {
    mayOpen: async () => permission,
    open: async (path) => {
      opened.push(path);
      return outcome;
    },
    refuse: async (message) => {
      refused.push(message);
    },
    register: async (run) => {
      registered.push(run);
      return !registerFails;
    },
  };

  return {
    effects,
    opened,
    refused,
    registered,
    answerOpenWith(next: OpenOutcome) {
      outcome = next;
    },
    failToOpen(error: string) {
      outcome = { kind: "refused", error };
    },
    failToRegister() {
      registerFails = true;
    },
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
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
    workflow: workflow(),
    ...overrides,
  };
}

/** What a harness's `create_workflow_draft` leaves behind, in two writes. */
async function handOver(store: ExchangeStore, key = "display-1"): Promise<void> {
  await store.createWorkflow(submission());
  await store.dropInbox({ kind: "display", key, workflowId: "workflow-1", revision: 1 });
}

async function waiting(store: ExchangeStore): Promise<string[]> {
  return (await readdir(join(store.root, "inbox"))).filter((name) => name.endsWith(".json"));
}

async function settled(store: ExchangeStore): Promise<string[]> {
  return readdir(join(store.root, "inbox", "done")).catch(() => []);
}

describe("a workflow handed over", () => {
  it("keeps an unreadable working copy and pending request, reports once, and recovers on restart", async () => {
    const store = await openStore();
    await handOver(store);
    const path = store.workingCopyPath("workflow-1");
    await writeFile(path, "incomplete local edit");
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);
    await inbox.read();
    await inbox.read();
    expect(window.refused).toHaveLength(1);
    expect(window.refused[0]).toContain("handover remains pending");
    expect(await readFile(path, "utf8")).toBe("incomplete local edit");
    expect(await waiting(store)).toEqual(["display-1.json"]);
    expect(window.opened).toEqual([]);
    await writeFile(path, JSON.stringify(workflow()));
    await new ExchangeInbox(store, window.effects).read();
    expect(await waiting(store)).toEqual([]);
    expect(window.opened).toEqual([path]);
  });

  it("is written where the editor will find it, opened, and the request retired", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();

    await new ExchangeInbox(store, window.effects).read();

    const path = store.workingCopyPath("workflow-1");
    expect(window.opened).toEqual([path]);
    expect(JSON.parse(await readFile(path, "utf8")).name).toBe("Ship the fix");
    expect(await waiting(store)).toEqual([]);
    expect(await settled(store)).toEqual(["display-1.json"]);
  });

  it("is not opened twice when the app looks again", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);

    await inbox.read();
    await inbox.read();

    expect(window.opened).toHaveLength(1);
  });

  /*
   * The whole point of the distinction: an app that was closed has not shown
   * anybody anything, and a drop in `done/` would say it had.
   */
  it("waits where it is while there is no window to show it in", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher("no_window");

    await new ExchangeInbox(store, window.effects).read();

    expect(window.opened).toEqual([]);
    expect(await waiting(store)).toEqual(["display-1.json"]);
    expect(await settled(store)).toEqual([]);
  });

  /* And the working copy is not written either, or a refusal would leave the
     harness's content in a file the user believes is theirs. */
  it("does not touch the working copy while there is nowhere to show it", async () => {
    const store = await openStore();
    await handOver(store);

    await new ExchangeInbox(store, watcher("no_window").effects).read();

    await expect(readFile(store.workingCopyPath("workflow-1"), "utf8")).rejects.toThrow();
  });

  it("stays in the inbox when the user keeps what they had open", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher("declined");

    await new ExchangeInbox(store, window.effects).read();

    expect(window.opened).toEqual([]);
    expect(await waiting(store)).toEqual(["display-1.json"]);
  });

  it("remembers refusal at the renderer's final guard without consuming or nagging", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();
    window.answerOpenWith({ kind: "declined" });
    const inbox = new ExchangeInbox(store, window.effects);
    await inbox.read();
    await inbox.read();
    expect(window.opened).toHaveLength(1);
    expect(window.refused).toEqual([]);
    expect(await waiting(store)).toEqual(["display-1.json"]);
  });

  /* Asking again two seconds later is not asking, it is nagging. */
  it("asks once per run of the app, not once per poll", async () => {
    const store = await openStore();
    await handOver(store);
    let asked = 0;
    const window = watcher("declined");
    const inbox = new ExchangeInbox(store, {
      ...window.effects,
      mayOpen: async () => {
        asked += 1;
        return "declined";
      },
    });

    await inbox.read();
    await inbox.read();
    await inbox.read();

    expect(asked).toBe(1);
  });

  /*
   * One screen, one workflow. The question a second one would have to ask is
   * about work the first has only just put in front of the user.
   */
  it("offers one workflow per pass, oldest first", async () => {
    const store = await openStore();
    await handOver(store, "display-1");
    await store.createWorkflow(submission({ idempotencyKey: "handover-8", workflow: workflow({ id: "workflow-2" }) }));
    await store.dropInbox({ kind: "display", key: "display-2", workflowId: "workflow-2", revision: 1 });
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);

    await inbox.read();
    expect(window.opened).toEqual([store.workingCopyPath("workflow-1")]);

    await inbox.read();
    expect(window.opened).toEqual([
      store.workingCopyPath("workflow-1"),
      store.workingCopyPath("workflow-2"),
    ]);
  });
});

describe("a request that cannot be carried out", () => {
  it("says so and retires the request when the revision cannot be read", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    await store.dropInbox({ kind: "display", key: "display-1", workflowId: "workflow-1", revision: 9 });
    const window = watcher();

    await new ExchangeInbox(store, window.effects).read();

    expect(window.opened).toEqual([]);
    expect(window.refused).toEqual([expect.stringContaining("revision 9") as string]);
    expect(await settled(store)).toEqual(["display-1.json"]);
  });

  /*
   * Being kept waiting is not being told no. The likeliest way an open does
   * not confirm is the ten seconds the page has to acknowledge it, which the
   * very next pass would get right — and treating that as a refusal filed the
   * handover as declined for the rest of the session, so the workflow never
   * appeared and nothing ever said why.
   */
  it("keeps asking while the page has not confirmed, and says nothing about it", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);

    for (const outcome of [{ kind: "unconfirmed", error: "no acknowledgement" }, { kind: "parked" }] as const) {
      window.answerOpenWith(outcome);
      await inbox.read();
      expect(window.refused).toEqual([]);
      expect(await waiting(store)).toEqual(["display-1.json"]);
      expect(await settled(store)).toEqual([]);
    }

    window.answerOpenWith({ kind: "shown" });
    await inbox.read();
    expect(window.opened).toHaveLength(3);
    expect(await settled(store)).toEqual(["display-1.json"]);
  });

  /*
   * The queue the window's close dialog shares. An acknowledgement takes as
   * long as the renderer takes to mount a document, and holding the queue for
   * that long swallowed every close click for ten seconds and answered every
   * other handover with "there is no window".
   */
  it("lets go of the window's queue before it waits on the page", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();
    const queue = new WindowOperations();
    let opening!: () => void;
    const reached = new Promise<void>((done) => { opening = done; });
    let finish!: () => void;
    const held = new Promise<void>((done) => { finish = done; });

    const pass = new ExchangeInbox(store, {
      ...window.effects,
      serialize: (work) => queue.run(work),
      open: async (path) => {
        window.opened.push(path);
        opening();
        await held;
        return { kind: "shown" };
      },
    }).read();

    await reached;
    const other = await Promise.race([
      queue.run(async () => "the window is free"),
      new Promise((done) => setTimeout(() => done("the window is held"), 50)),
    ]);
    expect(other).toBe("the window is free");
    finish();
    await pass;
  });

  /* Nothing is repaired: the request is answered with an error, and the file
     that could not be read is exactly as it was. */
  it("says so when the workflow on disk will not open", async () => {
    const store = await openStore();
    await handOver(store);
    const window = watcher();
    window.failToOpen("Unexpected token } in JSON at position 4");

    await new ExchangeInbox(store, window.effects).read();

    expect(window.refused).toEqual([
      expect.stringContaining("Unexpected token") as string,
    ]);
    expect(await settled(store)).toEqual([]);
    expect(await waiting(store)).toEqual(["display-1.json"]);
  });

  /*
   * A drop is reported as damaged only once it has failed to read twice, so a
   * file caught mid-arrival is given the next poll rather than being handed to
   * the app to destroy.
   */
  it("reports a drop nobody can read, on the second look and not the first", async () => {
    const store = await openStore();
    await mkdir(join(store.root, "inbox"), { recursive: true });
    await writeFile(join(store.root, "inbox", "display-1.json"), "{ half a", "utf8");
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);

    await inbox.read();
    expect(window.refused).toEqual([]);
    expect(await waiting(store)).toEqual(["display-1.json"]);

    await inbox.read();
    expect(window.refused).toHaveLength(1);
    expect(await settled(store)).toEqual(["display-1.json"]);
  });

  /*
   * Consuming a damaged drop can itself be refused — a `done/` record that
   * disagrees with the pending copy is exactly the damage being reported, and
   * neither is written over — so the request survives the pass that reported
   * it and the box must not come back with it.
   */
  it("says so once, even when the request cannot be taken out of the inbox", async () => {
    const store = await openStore();
    await mkdir(join(store.root, "inbox", "done"), { recursive: true });
    await writeFile(join(store.root, "inbox", "display-1.json"), "{ half a", "utf8");
    await writeFile(join(store.root, "inbox", "done", "display-1.json"), "{ a different half", "utf8");
    const window = watcher();
    const inbox = new ExchangeInbox(store, window.effects);

    await inbox.read();
    await inbox.read();
    await inbox.read();

    expect(window.refused).toHaveLength(1);
    expect(await waiting(store)).toEqual(["display-1.json"]);
  });
});

describe("a run the server bound", () => {
  async function bind(store: ExchangeStore): Promise<void> {
    await store.createWorkflow(submission());
    await store.bind("workflow-1", 1, { runId: "run-1", nonce: "nonce-1" });
    await store.dropInbox({
      kind: "bind",
      key: "bind-run-1",
      workflowId: "workflow-1",
      revision: 1,
      runId: "run-1",
    });
  }

  it("is registered with the run, the nonce and the content it started from", async () => {
    const store = await openStore();
    await bind(store);
    const window = watcher();

    await new ExchangeInbox(store, window.effects).read();

    const registered = window.registered[0];
    expect(registered.runId).toBe("run-1");
    expect(registered.nonce).toBe("nonce-1");
    expect(registered.harness).toBe("claude-code");
    expect(registered.workflowId).toBe("workflow-1");
    expect(registered.revision.revision).toBe(1);
    expect(await settled(store)).toEqual(["bind-run-1.json"]);
  });

  /* A bind asks the user nothing, so it has no reason to wait behind a
     workflow nobody has looked at yet. */
  it("is registered even while the workflow itself waits for a window", async () => {
    const store = await openStore();
    await bind(store);
    await store.dropInbox({ kind: "display", key: "display-1", workflowId: "workflow-1", revision: 1 });
    const window = watcher("no_window");

    await new ExchangeInbox(store, window.effects).read();

    expect(window.registered).toHaveLength(1);
    expect(await waiting(store)).toEqual(["display-1.json"]);
  });

  /*
   * A run reporting progress that nothing is listening for looks, to the
   * person watching, like a harness that never started.
   */
  it("stays in the inbox until it has somewhere to appear", async () => {
    const store = await openStore();
    await bind(store);
    const window = watcher();
    window.failToRegister();

    await new ExchangeInbox(store, window.effects).read();

    expect(window.registered).toHaveLength(1);
    expect(await waiting(store)).toEqual(["bind-run-1.json"]);
  });

  /*
   * Retrying in silence for ever is the same outcome as not retrying at all:
   * the Live Session page stays empty while the harness works through the
   * revision, and nothing anywhere says why.
   */
  it("says what a registration that never takes means, once, and keeps trying", async () => {
    const store = await openStore();
    await bind(store);
    const window = watcher();
    window.failToRegister();
    const inbox = new ExchangeInbox(store, window.effects);

    await inbox.read();
    await inbox.read();
    expect(window.refused).toEqual([]);

    await inbox.read();
    expect(window.refused).toHaveLength(1);
    expect(window.refused[0]).toContain("run-1");
    expect(window.refused[0]).toContain("Live Session");

    await inbox.read();
    expect(window.refused).toHaveLength(1);
    expect(window.registered).toHaveLength(4);
    expect(await waiting(store)).toEqual(["bind-run-1.json"]);
  });

  it("says so when the binding it names cannot be read", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());
    await store.dropInbox({
      kind: "bind",
      key: "bind-run-1",
      workflowId: "workflow-1",
      revision: 1,
      runId: "run-nobody-bound",
    });
    const window = watcher();

    await new ExchangeInbox(store, window.effects).read();

    expect(window.registered).toEqual([]);
    expect(window.refused).toEqual([
      expect.stringContaining("run-nobody-bound") as string,
    ]);
    expect(await settled(store)).toEqual(["bind-run-1.json"]);
  });
});
