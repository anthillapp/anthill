/**
 * The exclusive create, which is the whole of the store's concurrency story.
 *
 * Worth testing directly rather than only through the store, because every
 * other guarantee in this package is a consequence of this one: if two callers
 * could both be told "created" for one path, then revisions would not be
 * immutable, readiness would not belong to one revision, and a run could be
 * bound twice.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createExclusive, listDirectory, readTextIfPresent, removeFile } from "./disk.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-disk-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createExclusive", () => {
  it("creates the file and the directories on the way to it", async () => {
    const dir = await root();
    const path = join(dir, "deep", "deeper", "record.json");

    expect(await createExclusive(path, "first")).toEqual({ outcome: "created" });
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it("hands back what the winner wrote rather than overwriting it", async () => {
    const dir = await root();
    const path = join(dir, "record.json");
    await createExclusive(path, "first");

    expect(await createExclusive(path, "second")).toEqual({ outcome: "existed", text: "first" });
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it("gives exactly one of many simultaneous writers the file", async () => {
    const dir = await root();
    const path = join(dir, "record.json");

    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((text) => createExclusive(path, text)),
    );

    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    const winner = await readFile(path, "utf8");
    for (const result of results) {
      if (result.outcome === "existed") expect(result.text).toBe(winner);
    }
  });
});

describe("reading", () => {
  it("treats an absent file and an absent directory as the ordinary case", async () => {
    const dir = await root();

    expect(await readTextIfPresent(join(dir, "nothing.json"))).toBeUndefined();
    expect(await listDirectory(join(dir, "nowhere"))).toEqual([]);
  });

  it("lists what is there", async () => {
    const dir = await root();
    await writeFile(join(dir, "one.json"), "{}", "utf8");

    expect(await listDirectory(dir)).toEqual(["one.json"]);
  });
});

describe("removeFile", () => {
  it("does not mind a file that has already gone", async () => {
    const dir = await root();

    await expect(removeFile(join(dir, "nothing.json"))).resolves.toBeUndefined();
  });
});
