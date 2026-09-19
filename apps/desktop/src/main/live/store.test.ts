/**
 * The one file pending runs live in, and the startup race that could lose one.
 *
 * ANT-7. `loaded` was only set after the read finished, so two callers could
 * both decide the store was cold and both read. The second one's assignment
 * replaced whatever had been written in between — and at startup, "in between"
 * is precisely when a copied prompt registers its run.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPendingRun, type PendingRun } from "@anthill/live";

import { PendingRunStore } from "./store.js";

const NOW = "2026-08-29T10:00:00.000Z";

function run(id: string, partial: Partial<PendingRun> = {}): PendingRun {
  return {
    ...createPendingRun({
      anthillRunId: id,
      correlationNonce: "9f8e7d",
      selectedCli: "claude-code",
      promptVersion: "1",
      bootstrapPromptHash: "abcd1234",
      now: NOW,
    }),
    ...partial,
  };
}

async function storeAt(contents?: PendingRun[]) {
  const dir = await mkdtemp(join(tmpdir(), "anthill-store-"));
  const path = join(dir, "live-sessions.json");
  if (contents) await writeFile(path, JSON.stringify(contents), "utf8");
  return { path, store: new PendingRunStore(path) };
}

describe("loading what was left behind", () => {
  it("reads once, however many callers ask at the same time", async () => {
    const { store } = await storeAt([run("ANT-DISK")]);
    const first = store.load(NOW);
    const second = store.load(NOW);
    // Not merely equal results — the same read.
    expect(first).toBe(second);
    await first;
  });

  it("keeps a run registered while it was still reading", async () => {
    const { store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-NEW"));
    await loading;

    expect(store.all().map((item) => item.anthillRunId).sort()).toEqual(["ANT-DISK", "ANT-NEW"]);
  });

  it("writes that run to disk rather than the file it just read", async () => {
    const { path, store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-NEW"));
    await loading;

    const saved = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(saved.map((item) => item.anthillRunId).sort()).toEqual(["ANT-DISK", "ANT-NEW"]);
  });

  it("does not bring back a run removed while it was still reading", async () => {
    const { store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.remove("ANT-DISK");
    await loading;

    expect(store.find("ANT-DISK")).toBeUndefined();
  });

  it("prefers the in-memory copy of a run the file also has", async () => {
    const { store } = await storeAt([run("ANT-ONE")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-ONE", { state: "detected_live", detectedSessionId: "sess-1" }));
    await loading;

    expect(store.all()).toHaveLength(1);
    expect(store.find("ANT-ONE")?.detectedSessionId).toBe("sess-1");
  });

  it("settles a run whose window ran out while the app was closed", async () => {
    const { store } = await storeAt([run("ANT-OLD")]);
    await store.load("2026-08-29T11:00:00.000Z");
    expect(store.find("ANT-OLD")?.state).toBe("failed");
  });

  it("does not write a half-built view over the file it is about to read", async () => {
    // The race the two tests above only see intermittently: put() flushed
    // while the read was still on its way to the file, and whichever won
    // decided whether the file's own runs survived.
    const { path, store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-NEW"));

    // Mid-read, the file is still exactly what was there before.
    const midway = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(midway.map((item) => item.anthillRunId)).toEqual(["ANT-DISK"]);

    await loading;
    const after = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(after.map((item) => item.anthillRunId).sort()).toEqual(["ANT-DISK", "ANT-NEW"]);
  });

  it("survives a file that is missing, empty or not JSON at all", async () => {
    for (const contents of [undefined, "", "{not json"]) {
      const dir = await mkdtemp(join(tmpdir(), "anthill-store-"));
      const path = join(dir, "live-sessions.json");
      if (contents !== undefined) await writeFile(path, contents, "utf8");
      expect(await new PendingRunStore(path).load(NOW)).toEqual([]);
    }
  });
});

/**
 * Writes racing each other on the one file.
 *
 * From the In Review audit's finding on ANT-7: two unsynchronized `writeFile`
 * calls could land in either order, so the older snapshot could be the one
 * that survived. Writes are chained now, and each lands whole via a rename —
 * the file is only ever a complete snapshot, never a truncated one.
 */
describe("writes racing each other", () => {
  it("refuses an undurable registration, rolls it back, and allows a later retry", async () => {
    const { path, store } = await storeAt();
    await store.load(NOW);
    await rm(path);
    await mkdir(path);
    await expect(store.put(run("ANT-NEW"), true)).rejects.toThrow();
    expect(store.find("ANT-NEW")).toBeUndefined();
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await rm(path, { recursive: true });
    await store.put(run("ANT-NEW"), true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject([{ anthillRunId: "ANT-NEW" }]);
  });

  it("waits for a durable write when registration overlaps initial loading", async () => {
    const { path, store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-NEW"), true);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(2);
    await loading;
  });

  it("lets the last state win however the writes interleave", async () => {
    const { path, store } = await storeAt();
    await store.load(NOW);

    // Fired without awaiting, so both are in flight together.
    const first = store.put(run("ANT-ONE"));
    const second = store.put(run("ANT-TWO"));
    await Promise.all([first, second]);

    const saved = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(saved.map((item) => item.anthillRunId).sort()).toEqual(["ANT-ONE", "ANT-TWO"]);

    // And a fresh store over the same file reads that state back.
    const reread = await new PendingRunStore(path).load(NOW);
    expect(reread.map((item) => item.anthillRunId).sort()).toEqual(["ANT-ONE", "ANT-TWO"]);
  });

  it("survives a put-and-remove storm with the final state on disk", async () => {
    const { path, store } = await storeAt();
    await store.load(NOW);

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 8; i += 1) writes.push(store.put(run(`ANT-${i}`)));
    writes.push(store.remove("ANT-3"));
    writes.push(store.remove("ANT-5"));
    await Promise.all(writes);

    const saved = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(saved.map((item) => item.anthillRunId).sort()).toEqual(
      store
        .all()
        .map((item) => item.anthillRunId)
        .sort(),
    );
    expect(saved.some((item) => item.anthillRunId === "ANT-3")).toBe(false);
  });

  it("leaves no temp files behind", async () => {
    const { path, store } = await storeAt();
    await store.load(NOW);
    await Promise.all([store.put(run("ANT-A")), store.put(run("ANT-B"))]);

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(path, ".."));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("still holds the mid-read rule: the file is not touched while it is being read", async () => {
    const { path, store } = await storeAt([run("ANT-DISK")]);
    const loading = store.load(NOW);
    await store.put(run("ANT-NEW"));

    const midway = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(midway.map((item) => item.anthillRunId)).toEqual(["ANT-DISK"]);

    await loading;
    const after = JSON.parse(await readFile(path, "utf8")) as PendingRun[];
    expect(after.map((item) => item.anthillRunId).sort()).toEqual(["ANT-DISK", "ANT-NEW"]);
  });
});
