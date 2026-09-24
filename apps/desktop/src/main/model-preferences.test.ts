import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MODEL_PREFERENCES } from "@anthill/workflow";

import { ModelPreferencesStore } from "./model-preferences.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-model-prefs-"));
  dirs.push(dir);
  return join(dir, "model-preferences.json");
}

describe("the model preferences file", () => {
  it("is the defaults before anyone has said anything", async () => {
    expect(await new ModelPreferencesStore(await file()).read()).toEqual(DEFAULT_MODEL_PREFERENCES);
  });

  it("keeps what was written, across a restart", async () => {
    const path = await file();
    const next = { ...DEFAULT_MODEL_PREFERENCES, hidden: { codex: ["gpt-4.1"] }, defaults: { "claude-code": { id: "sonnet" } } };
    await new ModelPreferencesStore(path).write(next);
    expect(await new ModelPreferencesStore(path).read()).toEqual(next);
  });

  it("normalises on the way in rather than storing whatever it was handed", async () => {
    const path = await file();
    const written = await new ModelPreferencesStore(path).write({ hidden: { codex: ["a", "a", 3] }, nonsense: true });
    expect(written.hidden).toEqual({ codex: ["a"] });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("preferences.nonsense");
  });

  it("does not guess at a file from another version", async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({ version: 99, preferences: { hidden: { codex: ["x"] } } }));
    expect(await new ModelPreferencesStore(path).read()).toEqual(DEFAULT_MODEL_PREFERENCES);
  });

  it("says so when the disk refuses a write", async () => {
    // A directory where the file should be: the rename cannot land.
    const path = await file();
    await rm(path, { force: true });
    await (await import("node:fs/promises")).mkdir(path);
    await expect(new ModelPreferencesStore(path).write(DEFAULT_MODEL_PREFERENCES)).rejects.toThrow();
  });
});
