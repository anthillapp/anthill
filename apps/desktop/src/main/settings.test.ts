/**
 * A preference that does not survive a restart is not a preference.
 *
 * The other half of this file is what happens when the record is damaged. The
 * default matters there: notifications are off unless someone asked for them,
 * so an unreadable file has to mean silence rather than an app that starts
 * interrupting because it could not read its own record.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, SettingsStore, SETTINGS_VERSION } from "./settings.js";

let dir = "";
let path = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anthill-settings-"));
  path = join(dir, "settings.json");
});

describe("the preferences", () => {
  it("are the documented defaults on a machine that has never set any", async () => {
    const store = new SettingsStore(join(dir, "never-written.json"));
    expect(await store.read()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.stepNotifications).toBe(false);
  });

  it("survive a restart", async () => {
    await new SettingsStore(path).write({ stepNotifications: true });
    // A new store over the same file is what a restart looks like from here.
    expect(await new SettingsStore(path).read()).toEqual({ stepNotifications: true });
  });

  it("can be turned back off, and that survives too", async () => {
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    await store.write({ stepNotifications: false });
    expect(await new SettingsStore(path).read()).toEqual({ stepNotifications: false });
  });

  it("are patched, so a writer cannot erase a setting it has never heard of", async () => {
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    expect(await store.write({})).toEqual({ stepNotifications: true });
  });

  it("are handed back as a copy, so a caller cannot edit them in place", async () => {
    const store = new SettingsStore(path);
    const first = await store.read();
    first.stepNotifications = true;
    expect((await store.read()).stepNotifications).toBe(false);
  });
});

describe("a record this Anthill cannot read", () => {
  it("is the defaults when the file is not JSON", async () => {
    await writeFile(path, "{ not json at all", "utf8");
    expect(await new SettingsStore(path).read()).toEqual(DEFAULT_SETTINGS);
  });

  it("is the defaults when the envelope is a version this one does not speak", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: SETTINGS_VERSION + 1, settings: { stepNotifications: true } }),
      "utf8",
    );
    expect(await new SettingsStore(path).read()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the fields it understands when one is the wrong shape", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: SETTINGS_VERSION, settings: { stepNotifications: "yes please" } }),
      "utf8",
    );
    // "yes please" is not a boolean, and reading it as true would turn
    // notifications on for someone who never asked.
    expect(await new SettingsStore(path).read()).toEqual({ stepNotifications: false });
  });

  it("is replaced by the next write rather than blocking it", async () => {
    await writeFile(path, "{ not json at all", "utf8");
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    const written = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(written.version).toBe(SETTINGS_VERSION);
    expect(await new SettingsStore(path).read()).toEqual({ stepNotifications: true });
  });
});
