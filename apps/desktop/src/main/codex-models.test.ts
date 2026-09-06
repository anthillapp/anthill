/**
 * Reading Codex's own model catalogue.
 *
 * The alternative was a hand-kept copy of somebody else's model names in
 * Anthill's source, stale on their release schedule rather than ours — and a
 * stale name here is an agent file that fails at the far end.
 *
 * The distinction these tests exist for: "Anthill has not been told" is not the
 * same as "Codex offers nothing", and a missing or unreadable file is only ever
 * evidence for the first.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ChildProcessLike, SpawnFn } from "@anthill/runtimes";

import { readCachedCodexModels, readCodexModels } from "./codex-models.js";

async function cache(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-codex-"));
  const path = join(dir, "models_cache.json");
  await writeFile(path, contents, "utf8");
  return path;
}

const REAL = {
  fetched_at: "2026-09-05T22:53:12.445533Z",
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Balanced.",
      visibility: "list",
      priority: 12,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
      ],
    },
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      visibility: "list",
      priority: 1,
      supported_reasoning_levels: [{ effort: "low" }],
    },
    // Codex hides its own internal and retired entries.
    { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide", priority: 3 },
  ],
};

/** A `codex debug models` that answers, or refuses to. */
function codexSaying(stdout: string | undefined): SpawnFn {
  return () => {
    const closers: ((...args: unknown[]) => void)[] = [];
    const out: ((...args: unknown[]) => void)[] = [];
    const child: ChildProcessLike = {
      stdout: {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "data") out.push(listener);
          return undefined;
        },
        setEncoding: () => undefined,
      },
      stderr: { on: () => undefined, setEncoding: () => undefined },
      stdin: { write: () => true, end: () => undefined, on: () => undefined },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "close") closers.push(listener);
        return undefined;
      },
      kill: () => undefined,
    };
    queueMicrotask(() => {
      if (stdout !== undefined) for (const listener of out) listener(stdout);
      for (const listener of closers) listener(stdout === undefined ? 1 : 0);
    });
    return child;
  };
}

describe("where the catalogue comes from", () => {
  /* Codex's own answer is current by construction; the cache is only as fresh
     as the last time Codex fetched it. */
  it("asks Codex first and uses what it says", async () => {
    const found = await readCodexModels({
      spawnFn: codexSaying(JSON.stringify(REAL)),
      cachePath: await cache('{"models":[]}'),
    });
    expect(found?.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
  });

  /* `debug` is not a stability promise, so the file stays as a second source:
     if the command goes away the screen degrades to a slightly older list
     rather than to nothing. */
  it("falls back to the cache when Codex will not answer", async () => {
    const found = await readCodexModels({
      spawnFn: codexSaying(undefined),
      cachePath: await cache(JSON.stringify(REAL)),
    });
    expect(found?.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
  });

  it("says nothing when neither source can answer", async () => {
    const found = await readCodexModels({
      spawnFn: codexSaying(undefined),
      cachePath: join(tmpdir(), "anthill-does-not-exist.json"),
    });
    expect(found).toBeUndefined();
  });
});

describe("the catalogue", () => {
  it("reads the models Codex lists, with their reasoning levels", async () => {
    const found = await readCachedCodexModels(await cache(JSON.stringify(REAL)));
    expect(found?.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
    expect(found?.fetchedAt).toBe("2026-09-05T22:53:12.445533Z");

    const balanced = found?.models.find((model) => model.id === "gpt-5.5");
    expect(balanced?.label).toBe("GPT-5.5");
    expect(balanced?.hint).toBe("Balanced.");
    expect(balanced?.efforts.map((effort) => effort.id)).toEqual(["low", "high"]);
    expect(balanced?.defaultEffort).toBe("medium");
  });

  /* Offering what Codex hides from its own picker would be Anthill showing
     more than the tool it is describing. */
  it("leaves out what Codex does not list", async () => {
    const found = await readCachedCodexModels(await cache(JSON.stringify(REAL)));
    expect(found?.models.map((model) => model.id)).not.toContain("gpt-reserve");
  });

  it("keeps Codex's own ordering rather than the file's", async () => {
    const found = await readCachedCodexModels(await cache(JSON.stringify(REAL)));
    // gpt-6-astra is written second and has priority 1.
    expect(found?.models[0].id).toBe("gpt-6-astra");
  });

  /*
   * Nothing, never an empty list. An empty list would claim Codex offers no
   * models; the honest answer when the file is absent or broken is that Anthill
   * has not been told, which the screen says instead of showing a picker with
   * nothing in it.
   */
  it("says nothing rather than nothing-available when the file is missing", async () => {
    expect(await readCachedCodexModels(join(tmpdir(), "anthill-does-not-exist.json"))).toBeUndefined();
  });

  it("says nothing when the file cannot be read as a catalogue", async () => {
    expect(await readCachedCodexModels(await cache("{not json"))).toBeUndefined();
    expect(await readCachedCodexModels(await cache('{"models":"soon"}'))).toBeUndefined();
    expect(await readCachedCodexModels(await cache('{"models":[]}'))).toBeUndefined();
  });
});
