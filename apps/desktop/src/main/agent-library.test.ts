/**
 * The global agent library's one promise: remember profiles faithfully.
 *
 * The properties the screens will lean on: identity is an issued id that
 * survives every rename; a duplicate is a new identity, not a shared one;
 * everything comes back after a restart; and a broken file degrades to an
 * empty library rather than a crash.
 *
 * A library that has never existed is seeded with the profiles Anthill ships,
 * so counts here are stated relative to those rather than from zero.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AgentLibraryStore } from "./agent-library.js";

/** Architect, Adversarial Reviewer, Doc writer. */
const SHIPPED = 3;

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "anthill-agents-"));
  const path = join(dir, "global-agents.json");
  return { path, library: new AgentLibraryStore(path) };
}

/** What is in the library that this test put there. */
function written<T extends { starter?: boolean }>(profiles: T[]): T[] {
  return profiles.filter((item) => !item.starter);
}

describe("the global agent library", () => {
  it("creates a profile with an issued id and both clocks", async () => {
    const { library } = await store();
    const profile = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } }, role: "Reviews work" });
    expect(profile.id.startsWith("agent-")).toBe(true);
    expect(profile.createdAt).toBe(profile.updatedAt);
    expect(written(library.all())).toHaveLength(1);
  });

  it("keeps the id through a rename — references never break on a name", async () => {
    const { library } = await store();
    const created = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } } });
    const renamed = await library.update(created.id, { name: "Careful Reviewer" });
    expect(renamed?.id).toBe(created.id);
    expect(renamed?.name).toBe("Careful Reviewer");
    expect(renamed?.createdAt).toBe(created.createdAt);
  });

  it("gives a duplicate its own identity", async () => {
    const { library } = await store();
    const source = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } }, role: "Reviews" });
    const copy = await library.duplicate(source.id);
    expect(copy?.id).not.toBe(source.id);
    expect(copy?.name).toBe("Reviewer (copy)");
    expect(copy?.role).toBe("Reviews");
    expect(written(library.all())).toHaveLength(2);
  });

  it("survives a restart with everything it was told", async () => {
    const { path, library } = await store();
    await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } } });
    await library.create({ name: "Builder", models: { "claude-code": { id: "opus" } }, description: "Does the work" });

    const reopened = new AgentLibraryStore(path);
    const profiles = await reopened.load();
    expect(written(profiles).map((item) => item.name).sort()).toEqual(["Builder", "Reviewer"]);
  });

  it("removes a profile, and says so honestly when there was none", async () => {
    const { library } = await store();
    const created = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } } });
    expect(await library.remove(created.id)).toBe(true);
    expect(await library.remove(created.id)).toBe(false);
    expect(written(library.all())).toHaveLength(0);
  });

  it("ships three profiles into a library that has never existed", async () => {
    const { path, library } = await store();
    const seeded = await library.load();
    expect(seeded.map((item) => item.name)).toEqual([
      "Architect",
      "Adversarial Reviewer",
      "Doc writer",
    ]);
    // Provenance, not a kind: each is a profile like any other, and the flag
    // decides only which group it is listed under.
    expect(seeded.every((item) => item.starter === true)).toBe(true);
    // Written down, so the ids the workflows point at are the same next start.
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(SHIPPED);
  });

  it("does not put back the ones somebody deleted", async () => {
    const { path, library } = await store();
    const seeded = await library.load();
    for (const item of seeded) await library.remove(item.id);

    const reopened = new AgentLibraryStore(path);
    expect(await reopened.load()).toEqual([]);
  });

  it("edits a shipped profile in place rather than copying it", async () => {
    const { library } = await store();
    const [architect] = await library.load();
    const renamed = await library.update(architect.id, { name: "Planner" });
    expect(renamed?.id).toBe(architect.id);
    expect(library.all()).toHaveLength(SHIPPED);
  });

  it("refuses nothing loudly: a broken file is an empty library, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-agents-"));
    const path = join(dir, "global-agents.json");
    await writeFile(path, "{not json", "utf8");
    const library = new AgentLibraryStore(path);
    expect(written(await library.load())).toEqual([]);
  });

  /*
   * The upgrade case, and the reason the seed is keyed on what has been
   * offered rather than on the library being empty: everyone who used Anthill
   * before these existed already had a file, so a seed that waited for an
   * absent one would never reach the people most likely to want them.
   */
  it("offers the shipped profiles to a library that predates them", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        { id: "agent-mine", name: "Developer", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" },
      ]),
      "utf8",
    );

    const profiles = await library.load();
    expect(written(profiles).map((item) => item.name)).toEqual(["Developer"]);
    expect(profiles.filter((item) => item.starter)).toHaveLength(SHIPPED);
  });

  it("does not offer one twice, even to a library that is not empty", async () => {
    const { path, library } = await store();
    await library.load();
    const architect = library.all().find((item) => item.id === "agent-starter-architect");
    await library.remove(architect!.id);
    await library.create({ name: "Developer", models: { "claude-code": { id: "sonnet" } } });

    const reopened = new AgentLibraryStore(path);
    const names = (await reopened.load()).map((item) => item.name);
    expect(names).not.toContain("Architect");
    expect(names).toContain("Developer");
  });

  it("ships the models the profiles are written for", async () => {
    const { library } = await store();
    const seeded = await library.load();
    expect(seeded.map((item) => item.models)).toEqual([
      { "claude-code": { id: "opus" } },
      { "claude-code": { id: "opus" } },
      { "claude-code": { id: "haiku" } },
    ]);
  });

  it("writes whole files: concurrent creates all land and reload cleanly", async () => {
    const { path, library } = await store();
    await Promise.all([
      library.create({ name: "A", models: { "claude-code": { id: "sonnet" } } }),
      library.create({ name: "B", models: { "claude-code": { id: "sonnet" } } }),
      library.create({ name: "C", models: { "claude-code": { id: "sonnet" } } }),
    ]);
    const saved = JSON.parse(await readFile(path, "utf8")) as { starter?: boolean }[];
    expect(written(saved)).toHaveLength(3);
  });

  it("clears an optional field rather than storing it empty", async () => {
    // A profile carrying `role: ""` answers "yes, it has a role" to everything
    // downstream that only checks whether the field is there.
    const { library } = await store();
    const created = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } }, role: "Reviews" });
    const cleared = await library.update(created.id, { role: "  " });
    expect("role" in (cleared ?? {})).toBe(false);
  });

  /* `undefined` is "not mentioned", `""` is "clear it" — the distinction the
     renderer depends on, because every edit crosses IPC and a key with no
     value arrives looking exactly like one that was meant. */
  it("reads a field named with no value as one nobody touched", async () => {
    const { library } = await store();
    const created = await library.create({
      name: "Reviewer",
      models: { "claude-code": { id: "sonnet" } },
      role: "Reviews",
      description: "Reads the change against what it claims to do.",
    });
    const patched = await library.update(created.id, {
      models: { "claude-code": { id: "opus" } },
      role: undefined,
      description: undefined,
    });
    expect(patched?.models).toEqual({ "claude-code": { id: "opus" } });
    expect(patched?.role).toBe("Reviews");
    expect(patched?.description).toBe("Reads the change against what it claims to do.");
  });

  it("leaves a field alone when the update does not mention it", async () => {
    const { library } = await store();
    const created = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } }, role: "Reviews" });
    const renamed = await library.update(created.id, { name: "Careful" });
    expect(renamed?.role).toBe("Reviews");
    expect(renamed?.models).toEqual({ "claude-code": { id: "sonnet" } });
  });

  it("lets a profile have answered for no tool at all", async () => {
    // The library has no harness of its own. Inventing a model at creation
    // time would be a claim about a tool the profile has not met yet.
    const { library } = await store();
    const created = await library.create({ name: "Reviewer" });
    expect("models" in created).toBe(false);
  });

  /* The absence of a tool's key is the message, so an empty bag has to be able
     to send it. */
  it("unanswers every tool when the update sends an empty bag", async () => {
    const { library } = await store();
    const created = await library.create({
      name: "Reviewer",
      models: { "claude-code": { id: "opus" } },
    });
    const cleared = await library.update(created.id, { models: {} });
    expect("models" in (cleared ?? {})).toBe(false);
  });

  /* Codex has a reasoning effort where Claude Code has none, and it is stored
     beside the model rather than folded into it. */
  it("keeps a Codex reasoning effort beside its model", async () => {
    const { library } = await store();
    const created = await library.create({
      name: "Reviewer",
      models: { codex: { id: "gpt-5.6-sol", reasoningEffort: "high" } },
    });
    expect(created.models).toEqual({ codex: { id: "gpt-5.6-sol", reasoningEffort: "high" } });
  });

  it("keeps the two tools' answers independent of each other", async () => {
    const { library } = await store();
    const created = await library.create({
      name: "Reviewer",
      models: { "claude-code": { id: "opus" }, codex: { id: "gpt-5.5" } },
    });
    const patched = await library.update(created.id, {
      models: { ...created.models, codex: { id: "gpt-5.4-mini" } },
    });
    expect(patched?.models).toEqual({
      "claude-code": { id: "opus" },
      codex: { id: "gpt-5.4-mini" },
    });
  });

  /*
   * Library files written before the model was split by harness. Migration
   * happens on read, never guesses, and reads nothing about the machine — the
   * same file has to migrate the same way on every computer it is opened on.
   */
  it("reads a pre-split model as configuration for the harness that offers it", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        { id: "agent-1", name: "Reviewer", model: "opus", createdAt: "x", updatedAt: "x" },
      ]),
      "utf8",
    );
    const [profile] = written(await library.load());
    expect(profile.models).toEqual({ "claude-code": { id: "opus" } });
  });

  /* The pass that allowed one answer in total becomes that tool's answer, and
     the tool it said nothing about stays unanswered. */
  it("reads the single-answer shape as the answer for its own tool", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        {
          id: "agent-1",
          name: "Reviewer",
          model: { target: "codex", id: "gpt-5.5" },
          createdAt: "x",
          updatedAt: "x",
        },
      ]),
      "utf8",
    );
    const [profile] = written(await library.load());
    expect(profile.models).toEqual({ codex: { id: "gpt-5.5" } });
    expect("modelNeedsReview" in profile).toBe(false);
  });

  it("holds an unattributable pre-split model for review instead of guessing", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        { id: "agent-1", name: "Reviewer", model: "gpt-5", createdAt: "x", updatedAt: "x" },
      ]),
      "utf8",
    );
    const [profile] = written(await library.load());
    expect(profile.modelNeedsReview).toBe("gpt-5");
    expect("models" in profile).toBe(false);
  });

  /* Reading migrates; this is what makes it stick. Without it an older shape
     sits beside the current one indefinitely, and every reader has to decide
     between them again. */
  it("writes a migrated library back without waiting for an edit", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        {
          id: "agent-1",
          name: "Reviewer",
          models: { "claude-code": "opus" },
          createdAt: "x",
          updatedAt: "x",
        },
      ]),
      "utf8",
    );

    await library.load();

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>[];
    const row = saved.find((item) => item.id === "agent-1");
    expect(row?.models).toEqual({ "claude-code": { id: "opus" } });
    expect("model" in (row ?? {})).toBe(false);
  });

  it("keeps a migrated profile migrated once it is written back", async () => {
    const { path, library } = await store();
    await writeFile(
      path,
      JSON.stringify([
        { id: "agent-1", name: "Reviewer", model: "opus", createdAt: "x", updatedAt: "x" },
      ]),
      "utf8",
    );
    await library.load();
    await library.update("agent-1", { name: "Careful" });

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>[];
    const row = saved.find((item) => item.id === "agent-1");
    expect(row?.models).toEqual({ "claude-code": { id: "opus" } });
    expect("model" in (row ?? {})).toBe(false);
  });

  it("keeps an unnamed profile unnamed", async () => {
    // "Unnamed agent" is what an empty name reads as; storing it would make a
    // placeholder indistinguishable from a name somebody chose.
    const { library } = await store();
    const created = await library.create({ name: "   " });
    expect(created.name).toBe("");
  });

  it("never lets an update touch identity", async () => {
    const { library } = await store();
    const created = await library.create({ name: "Reviewer", models: { "claude-code": { id: "sonnet" } } });
    const updated = await library.update(created.id, {
      // @ts-expect-error — the input type has no id on purpose; a caller
      // smuggling one in must find it ignored.
      id: "agent-hijacked",
      name: "Still the same agent",
    });
    expect(updated?.id).toBe(created.id);
  });
});
