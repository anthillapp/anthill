/**
 * ANT-228. The web shell receives handovers.
 *
 * A harness writes into `<data dir>/exchange` for the web shell exactly as it
 * does for the desktop; these drive the bridge the way a tab would, against a
 * real store in a temporary directory, with a short poll and a tab count the
 * test sets. What a tab is sent is read off the broadcast.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION, type DraftSubmission } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

import { HANDOVER_REFUSED_CHANNEL, IpcChannel, OPEN_WORKFLOW_CHANNEL } from "../../desktop/src/shared/ipc.js";
import { createBridge, type Bridge } from "./bridge.js";
import { appendReport } from "./report.js";

vi.mock("../../desktop/src/main/user-path.js", () => ({ adoptUserPath: async () => false }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function workflow(id = "workflow-1"): Workflow {
  return {
    id,
    name: "Ship the fix",
    version: "0.1.0",
    target: "claude-code",
    brief: { goal: "The startup crash is fixed and covered by a test.", doneCriteria: ["The test suite passes."] },
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
        agents: [
          {
            id: "agent-1",
            name: "Developer",
            description: "Reads the code around the change, makes the smallest fix that holds, and hands back a diff with a test that fails without it.",
            models: { "claude-code": { id: "sonnet" } },
          },
        ],
      },
    },
  };
}

function submission(id = "workflow-1"): DraftSubmission {
  return {
    exchangeVersion: 1,
    idempotencyKey: `handover-${id}`,
    source: { harness: "claude-code", sessionId: "session-abc", taskText: "Fix the crash on startup." },
    mode: "design",
    workflow: workflow(id),
  };
}

type Pushed = { channel: string; payload: unknown };
type Open = { path: string; deliveryId: number };
type Handler = (message: unknown, reply: (message: unknown) => void, tab?: number) => void;

/**
 * A web shell over a temporary data directory, driven the way the server
 * drives it: every call arrives with the id of the tab that made it, a
 * handover is sent to one tab, and a tab can go away.
 */
async function shell(options: { before?: (store: ExchangeStore) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "anthill-web-handover-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const userData = join(root, "data");
  const store = new ExchangeStore(userData);
  await options.before?.(store);

  const broadcast: Pushed[] = [];
  const sent = new Map<number, Pushed[]>();
  const connected = new Set<number>();
  const closedListeners: ((tab: number) => void)[] = [];
  let handler: Handler | undefined;
  const bridge: Bridge = await createBridge({
    paths: { userData, home: root },
    broadcast: (message) => broadcast.push(message as Pushed),
    onMessage: (registered) => { handler = registered as Handler; },
    notify: () => undefined,
    sendTo: (tab, message) => {
      if (!connected.has(tab)) return false;
      sent.set(tab, [...(sent.get(tab) ?? []), message as Pushed]);
      return true;
    },
    onTabClosed: (listener) => { closedListeners.push(listener); },
    exchangePollMs: 20,
  });
  cleanup.push(() => bridge.close());

  let nextCall = 1;
  // Through JSON, as the /api socket carries it: an argument left undefined
  // arrives as null (ANT-234).
  const call = (tab: number, channel: string, ...args: unknown[]): Promise<unknown> =>
    new Promise((settleCall) => handler!(JSON.parse(JSON.stringify({ id: nextCall++, channel, args })), settleCall, tab));

  const tab = (id: number) => ({
    /** What a page does on mount: collect anything waiting, naming the workflow in its URL if any. */
    connect: (routed?: string) => {
      connected.add(id);
      return call(id, IpcChannel.workflowPendingOpen, ...(routed ? [routed] : []));
    },
    /** A socket that is open but whose page has not asked yet. */
    socket: () => { connected.add(id); },
    opens: (): Open[] => (sent.get(id) ?? []).filter((m) => m.channel === OPEN_WORKFLOW_CHANNEL).map((m) => m.payload as Open),
    /**
     * What a page does once the document is on screen, or when the user says
     * no. On screen, the canvas names no outcome (`workflowOpened(path, id)`),
     * and the web bridge still sends all three places.
     */
    answer: (open: Open, outcome?: "shown" | "declined" | "confirming") =>
      call(id, IpcChannel.workflowOpened, open.path, open.deliveryId, outcome),
    close: () => {
      connected.delete(id);
      for (const listener of closedListeners) listener(id);
    },
  });

  const refusals = () => broadcast.filter((message) => message.channel === HANDOVER_REFUSED_CHANNEL)
    .map((message) => message.payload as string);
  const display = async (id = "workflow-1", key = `display-${id}`) => {
    await store.createWorkflow(submission(id));
    await store.dropInbox({ kind: "display", key, workflowId: id, revision: 1 });
  };
  const pending = async () => (await store.listInbox()).drops;

  return { bridge, store, tab, refusals, display, pending, broadcast, paths: { userData, home: root } };
}

async function until<T>(read: () => T | undefined | false, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

const settle = (ms = 150) => new Promise((done) => setTimeout(done, ms));

describe("the web shell receives handovers", () => {
  it("shows a request stored before it started to the first tab that connects, and consumes it once shown", async () => {
    const web = await shell({ before: async (store) => {
      await store.createWorkflow(submission());
      await store.dropInbox({ kind: "display", key: "display-1", workflowId: "workflow-1", revision: 1 });
    } });
    const tab = web.tab(1);

    // No tab yet: nothing is sent, and the request waits.
    await settle();
    expect(await web.pending()).toHaveLength(1);

    await tab.connect();
    const [open] = await until(() => tab.opens().length > 0 && tab.opens());
    expect(open!.path).toBe(web.store.workingCopyPath("workflow-1"));

    await tab.answer(open!);
    await settle();
    expect(await web.pending()).toEqual([]);
    // Shown once: no second push for the same request.
    expect(tab.opens()).toHaveLength(1);
  });

  it("pushes a request that arrives while a tab is open, to that tab only", async () => {
    const web = await shell();
    const tab = web.tab(1);
    await tab.connect();

    await web.display("workflow-2");

    const [open] = await until(() => tab.opens().length > 0 && tab.opens());
    expect(open).toMatchObject({ path: web.store.workingCopyPath("workflow-2"), deliveryId: expect.any(Number) });
    expect(web.broadcast.filter((m) => m.channel === OPEN_WORKFLOW_CHANNEL)).toEqual([]);
    await tab.answer(open!);
    await settle();
    expect(await web.pending()).toEqual([]);
  });

  it("does not count a socket whose page has not asked yet, and waits once the last tab closes", async () => {
    const web = await shell();
    const early = web.tab(1);
    early.socket();
    await web.display();
    await settle();
    expect(early.opens()).toEqual([]);

    const tab = web.tab(2);
    await tab.connect();
    tab.close();
    await web.display("workflow-3");
    await settle();
    expect(await web.pending()).toHaveLength(2);
  });

  it("goes to the tab that asked last, and only its answer counts", async () => {
    const web = await shell();
    const first = web.tab(1);
    const second = web.tab(2);
    await first.connect();
    await second.connect();

    await web.display();
    const [open] = await until(() => second.opens().length > 0 && second.opens());
    expect(first.opens()).toEqual([]);

    // An answer from a tab it was not sent to is not an answer.
    await first.answer(open!, "declined");
    await settle();
    expect(await web.pending()).toHaveLength(1);

    await second.answer(open!);
    await settle();
    expect(await web.pending()).toEqual([]);
  });

  it("shows a workflow again to a reloaded tab, which is a new connection", async () => {
    const web = await shell({ before: async (store) => { await store.createWorkflow(submission()); } });
    const tab = web.tab(1);
    await tab.connect("workflow-1");
    const [open] = await until(() => tab.opens().length > 0 && tab.opens());
    await tab.answer(open!);

    // The reload: the old socket closes, and the page asks again from the same URL.
    tab.close();
    const reloaded = web.tab(2);
    await reloaded.connect("workflow-1");

    const [again] = await until(() => reloaded.opens().length > 0 && reloaded.opens());
    expect(again!.path).toBe(web.store.workingCopyPath("workflow-1"));
  });

  it("sends a workflow another tab is already showing to the tab that asked for it", async () => {
    const web = await shell({ before: async (store) => { await store.createWorkflow(submission()); } });
    const first = web.tab(1);
    await first.connect("workflow-1");
    const [open] = await until(() => first.opens().length > 0 && first.opens());
    await first.answer(open!);

    const second = web.tab(2);
    await second.connect("workflow-1");
    await until(() => second.opens().length > 0);
  });

  it("gives a request back to the inbox when its tab closes before answering, and says nothing", async () => {
    const web = await shell();
    const tab = web.tab(1);
    await tab.connect();
    await web.display();
    await until(() => tab.opens().length > 0);

    tab.close();
    await settle();
    expect(await web.pending()).toHaveLength(1);
    expect(web.refusals()).toEqual([]);

    const next = web.tab(2);
    await next.connect();
    await until(() => next.opens().length > 0);
  });

  it("sends on a link that was waiting behind a delivery whose tab closed", async () => {
    const web = await shell({ before: async (store) => { await store.createWorkflow(submission("workflow-2")); } });
    const first = web.tab(1);
    await first.connect();
    await web.display();
    const [held] = await until(() => first.opens().length > 0 && first.opens());
    // The first tab is asking its user whether to discard, which has no timeout.
    await first.answer(held!, "confirming");

    const second = web.tab(2);
    await second.connect("workflow-2");
    // Long enough for the link to be queued behind the first tab's delivery.
    await settle();
    expect(second.opens()).toEqual([]);
    first.close();

    const sent = await until(() => second.opens().find((open) => open.path === web.store.workingCopyPath("workflow-2")));
    // Answered, so the test does not end with the shell still delivering.
    await second.answer(sent);
    await settle();
  });

  it("opens the workflow a tab at /workflow/<id> names", async () => {
    const web = await shell({ before: async (store) => { await store.createWorkflow(submission()); } });
    const tab = web.tab(1);

    await tab.connect("workflow-1");

    const [open] = await until(() => tab.opens().length > 0 && tab.opens());
    expect(open!.path).toBe(web.store.workingCopyPath("workflow-1"));
    expect(web.refusals()).toEqual([]);
  });

  it.each([["an unknown id", "no-such-workflow", "missing or unreadable"], ["an id that is not one", "..", "not a workflow id"]])(
    "says so in the tab for %s, and opens nothing", async (_name, id, why) => {
      const web = await shell();
      const tab = web.tab(1);

      await tab.connect(id);

      const [refusal] = await until(() => web.refusals().length > 0 && web.refusals());
      expect(refusal).toContain(why);
      await settle();
      expect(tab.opens()).toEqual([]);
    },
  );

  it("sends nothing once closed", async () => {
    const web = await shell();
    const tab = web.tab(1);
    await tab.connect();
    await web.bridge.close();

    await web.display();
    await settle();
    expect(tab.opens()).toEqual([]);
  });
});

/*
  ANT-229. What the user does with a handed-over workflow in the web shell,
  and the run a harness binds to it: saved revisions the harness reads back,
  and a bound run followed Live until its harness says it is done.
*/
describe("the web shell works with a handed-over workflow", () => {
  /** A workflow handed over and on screen in one tab, as after a `design`. */
  async function onScreen() {
    const web = await shell({ before: async (store) => { await store.createWorkflow(submission()); } });
    const tab = web.tab(1);
    await tab.connect("workflow-1");
    const [open] = await until(() => tab.opens().length > 0 && tab.opens());
    await tab.answer(open!);
    return { ...web, path: open!.path };
  }

  it("saves an edit as a new revision, which is what the harness reads back as ready", async () => {
    const web = await onScreen();
    const edited = { ...workflow(), name: "Ship the fix, carefully" };

    const saved = await web.bridge.api.saveWorkflow({ path: web.path, workflow: edited });

    expect(saved).toEqual({ kind: "saved", path: web.path });
    const eligible = await web.store.eligibleRevision("workflow-1");
    expect(eligible).toMatchObject({ eligible: true, state: "ready_for_agent" });
    expect(eligible.eligible && eligible.revision).toMatchObject({ revision: 2, workflow: { name: "Ship the fix, carefully" } });
    expect(await web.bridge.api.exchangeRead(web.path, "workflow-1"))
      .toMatchObject({ workflowId: "workflow-1", revision: 2, state: "ready_for_agent", bindings: [] });
  });

  it("refuses to save another workflow over a handed-over one's working copy", async () => {
    const web = await onScreen();

    // The working copy is open, so the file gate passes; the exchange's own check is what refuses.
    const saved = await web.bridge.api.saveWorkflow({ path: web.path, workflow: workflow("workflow-other") });

    expect(saved).toMatchObject({ kind: "failed", error: expect.stringContaining("reserved for exchange records or another workflow") });
    expect((await web.store.readWorkflow("workflow-1"))?.head?.revision).toBe(1);
  });

  it("follows a run the harness binds, draws it from the bound revision, and ends it when the harness says done", async () => {
    const web = await onScreen();
    const bound = await web.store.bindRequest("workflow-1", 1, (await web.store.readRevision("workflow-1", 1))!.digest,
      "bind-1", undefined, () => ({ runId: "ANT-RUN1", nonce: "nonce1" }));
    expect(bound.outcome).toBe("bound");
    await web.store.dropInbox({ kind: "bind", key: "bind-ANT-RUN1", workflowId: "workflow-1", revision: 1, runId: "ANT-RUN1" });

    // The inbox registers it with the live service, and the bind request is consumed.
    const registered = await waitFor(async () => (await web.bridge.api.liveSnapshot()).runs.find((r) => r.anthillRunId === "ANT-RUN1"));
    expect(registered).toMatchObject({ workflowId: "workflow-1", exchange: { revision: 1 } });
    await waitFor(async () => (await web.pending()).length === 0);

    // An edit saved after the bind is a new head; Live still draws what the run was bound to.
    await web.bridge.api.saveWorkflow({ path: web.path, workflow: { ...workflow(), name: "Edited after the bind" } });
    expect((await web.store.readWorkflow("workflow-1"))?.head?.revision).toBe(2);
    expect(await web.bridge.api.liveWorkflow("ANT-RUN1"))
      .toMatchObject({ ok: true, revision: 1, workflow: { id: "workflow-1", name: "Ship the fix" } });

    // What `anthill run/step/done` write, in this shell's own data directory.
    const at = () => new Date().toISOString();
    await appendReport(web.paths, { kind: "run", runId: "ANT-RUN1", nonce: "nonce1", at: at() });
    await appendReport(web.paths, { kind: "step", runId: "ANT-RUN1", nonce: "nonce1", stepId: "step-1", at: at() });
    await appendReport(web.paths, { kind: "done", runId: "ANT-RUN1", nonce: "nonce1", at: at() });

    // Read on the live service's own poll.
    const finished = await waitFor(async () => {
      const current = (await web.bridge.api.liveSnapshot()).runs.find((r) => r.anthillRunId === "ANT-RUN1");
      return current?.state === "completed" && current;
    }, 8000);
    expect(finished).toMatchObject({ state: "completed" });
  }, 15000);
});

async function waitFor<T>(read: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 25));
  }
}

