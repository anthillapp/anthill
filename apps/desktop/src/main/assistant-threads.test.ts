/**
 * The record that has to outlive the panel.
 *
 * ANT-82: the assistant's thread was React state, so the close button destroyed
 * it. These hold the properties that make the fix a fix rather than a place to
 * put the same loss — a thread comes back after a restart, one workflow's
 * conversation is never another's, and nothing but an explicit clear removes
 * one.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { AssistantThreadStore, THREADS_VERSION } from "./assistant-threads.js";

let dir = "";
let path = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anthill-threads-"));
  path = join(dir, "assistant-threads.json");
});

const turn = (text: string) => ({ kind: "user", text, mentions: [] });

describe("a thread", () => {
  it("comes back after the panel, the window and the app have gone", async () => {
    const store = new AssistantThreadStore(path);
    await store.write("workflow-1", [turn("Add a review step"), turn("Make it stricter")]);

    // A new store against the same file is what a restart looks like from here.
    const afterRestart = new AssistantThreadStore(path);
    expect(await afterRestart.read("workflow-1")).toEqual([
      turn("Add a review step"),
      turn("Make it stricter"),
    ]);
  });

  it("belongs to one workflow and never leaks into another", async () => {
    const store = new AssistantThreadStore(path);
    await store.write("workflow-1", [turn("One")]);
    await store.write("workflow-2", [turn("Two")]);

    expect(await store.read("workflow-1")).toEqual([turn("One")]);
    expect(await store.read("workflow-2")).toEqual([turn("Two")]);
    expect(await store.read("workflow-3")).toEqual([]);
  });

  it("is replaced whole, because a turn changes after it is made", async () => {
    // A proposal becomes applied, or refuses and gains a reason. The panel has
    // the last word on what the thread contains; this store does not accumulate.
    const store = new AssistantThreadStore(path);
    await store.write("workflow-1", [{ kind: "proposal", summary: "Add review", proposal: {} }]);
    await store.write("workflow-1", [
      { kind: "proposal", summary: "Add review", proposal: {}, resolved: "applied" },
    ]);

    const stored = await store.read("workflow-1");
    expect(stored).toHaveLength(1);
    expect((stored[0] as { resolved?: string }).resolved).toBe("applied");
  });

  it("goes only when it is asked to go", async () => {
    const store = new AssistantThreadStore(path);
    await store.write("workflow-1", [turn("Keep me")]);
    await store.write("workflow-2", [turn("And me")]);

    await store.clear("workflow-1");

    expect(await store.read("workflow-1")).toEqual([]);
    expect(await store.read("workflow-2")).toEqual([turn("And me")]);
  });

  it("stores an empty thread as an absence rather than a key per workflow opened", async () => {
    const store = new AssistantThreadStore(path);
    await store.write("workflow-1", []);
    const written = JSON.parse(await readFile(path, "utf8")) as { threads: Record<string, unknown> };
    expect(Object.keys(written.threads)).toEqual([]);
  });
});

describe("a record this Anthill cannot read", () => {
  it("is an empty thread, not a failure to open the workflow", async () => {
    await writeFile(path, "{ this is not json", "utf8");
    const store = new AssistantThreadStore(path);
    expect(await store.read("workflow-1")).toEqual([]);
  });

  it("is an empty thread when the envelope is a version this one does not speak", async () => {
    // Guessing at a shape from the future is how a thread comes back subtly
    // wrong, which is worse than coming back missing.
    await writeFile(
      path,
      JSON.stringify({ version: THREADS_VERSION + 1, threads: { "workflow-1": { turns: [turn("Hi")] } } }),
      "utf8",
    );
    const store = new AssistantThreadStore(path);
    expect(await store.read("workflow-1")).toEqual([]);
  });

  it("keeps the threads it can read when one entry is malformed", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: THREADS_VERSION,
        threads: {
          "workflow-1": { updatedAt: "2026-09-16T00:00:00.000Z", turns: [turn("Good")] },
          "workflow-2": { updatedAt: "2026-09-16T00:00:00.000Z", turns: "not a list" },
        },
      }),
      "utf8",
    );
    const store = new AssistantThreadStore(path);
    expect(await store.read("workflow-1")).toEqual([turn("Good")]);
    expect(await store.read("workflow-2")).toEqual([]);
  });

  it("is an empty thread when there is no file at all", async () => {
    const store = new AssistantThreadStore(join(dir, "never-written.json"));
    expect(await store.read("workflow-1")).toEqual([]);
  });
});

describe("the file", () => {
  it("drops whole threads, oldest first, rather than trimming one from the inside", async () => {
    // A thread with its beginning missing is a worse answer than no thread.
    let tick = 0;
    const store = new AssistantThreadStore(path, () =>
      new Date(Date.parse("2026-09-16T00:00:00.000Z") + tick++ * 1000).toISOString(),
    );
    for (let at = 0; at < 45; at += 1) {
      await store.write(`workflow-${at}`, [turn(`message ${at}`)]);
    }

    const written = JSON.parse(await readFile(path, "utf8")) as { threads: Record<string, unknown> };
    expect(Object.keys(written.threads)).toHaveLength(40);
    // The five earliest are gone; the newest is whole.
    expect(written.threads["workflow-0"]).toBeUndefined();
    expect(written.threads["workflow-4"]).toBeUndefined();
    expect(await store.read("workflow-44")).toEqual([turn("message 44")]);
  });

  it("lands whole, so a reader never sees half a write", async () => {
    const store = new AssistantThreadStore(path);
    await Promise.all([
      store.write("workflow-1", [turn("a")]),
      store.write("workflow-1", [turn("b")]),
      store.write("workflow-1", [turn("c")]),
    ]);
    const text = await readFile(path, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
