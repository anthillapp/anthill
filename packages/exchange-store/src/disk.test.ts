/**
 * The exclusive create, which is the whole of the store's concurrency story.
 *
 * Worth testing directly rather than only through the store, because every
 * other guarantee in this package is a consequence of this one: if two callers
 * could both be told "created" for one path, then revisions would not be
 * immutable, readiness would not belong to one revision, and a run could be
 * bound twice.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createExclusive, listDirectory, readTextIfPresent, removeFile } from "./disk.js";

const run = promisify(execFile);
const child = join(dirname(fileURLToPath(import.meta.url)), "exclusive-write-child.mjs");

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

  it("leaves nothing of its own behind", async () => {
    const dir = await root();

    await createExclusive(join(dir, "record.json"), "first");
    await createExclusive(join(dir, "record.json"), "second");

    // The temporary file each write goes through is removed whether the name
    // was won or lost; a store whose directories fill up with the losers'
    // working files would have swapped one leak for another.
    expect(await listDirectory(dir)).toEqual(["record.json"]);
  });
});

/**
 * The same race, run by two processes, which is the only way to see it.
 *
 * Every test above happens inside one process, where libuv runs the filesystem
 * calls on one thread pool and reliably queues the winner's write ahead of the
 * loser's read. That ordering is an accident of the runtime and not a promise
 * the kernel makes. Under the exclusive create this store used to do, two real
 * processes racing a large record had the loser read the winner's file back at
 * zero bytes — the name existed from the moment of `open`, and the content
 * arrived afterwards — and every caller in the store reads an existing file
 * back to decide whether it is looking at its own retry or at somebody else's
 * claim. So the loser reported a conflict against a record that was about to be
 * perfectly healthy, and nothing in the package could tell the difference.
 */
describe("createExclusive with a second process", () => {
  /** Big enough that the write cannot finish inside one scheduling slice. */
  const SIZE = 2_000_000;
  const ROUNDS = 4;

  it("never shows the loser a name whose content has not arrived", async () => {
    const dir = await root();

    for (let round = 0; round < ROUNDS; round += 1) {
      const path = join(dir, `record-${round}.json`);
      // Both processes are already running and spinning by the time either
      // reaches the claim, so neither wins by being started first.
      const startAt = String(Date.now() + 300);
      const answers = await Promise.all(
        ["a", "b"].map(async (tag) => {
          const { stdout } = await run(process.execPath, [
            child,
            path,
            tag,
            startAt,
            String(SIZE),
          ]);
          return JSON.parse(stdout) as {
            outcome: "created" | "existed";
            readBack?: number;
            characters?: number;
          };
        }),
      );

      expect(answers.filter((answer) => answer.outcome === "created")).toHaveLength(1);
      const loser = answers.find((answer) => answer.outcome === "existed");
      expect(loser?.readBack).toBe(SIZE);
      expect(loser?.characters).toBe(1);
      expect((await readFile(path, "utf8")).length).toBe(SIZE);
    }
  }, 60_000);
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
