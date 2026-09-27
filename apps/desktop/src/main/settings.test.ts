/**
 * A preference that does not survive a restart is not a preference.
 *
 * The other half of this file is what happens when the record is damaged. The
 * default matters there: notifications are off unless someone asked for them,
 * so an unreadable file has to mean silence rather than an app that starts
 * interrupting because it could not read its own record.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, SettingsStore, SETTINGS_VERSION, reportingConsentOnDisk, workflowFolderPath } from "./settings.js";

let dir = "";
let path = "";

/** Everything off but the first switch, which is what the old file expressed. */
const on = { ...DEFAULT_SETTINGS, stepNotifications: true };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anthill-settings-"));
  path = join(dir, "settings.json");
});

describe("the preferences", () => {
  it("applies concurrent patches to the latest durable settings", async () => {
    const store = new SettingsStore(path);
    await Promise.all([store.write({ stepNotifications: true }), store.write({})]);
    expect(await store.read()).toEqual(on);
    expect(await new SettingsStore(path).read()).toEqual(on);
  });
  it("are the documented defaults on a machine that has never set any", async () => {
    const store = new SettingsStore(join(dir, "never-written.json"));
    expect(await store.read()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.stepNotifications).toBe(false);
    // Analytics and error reports are on unless turned off; memory dumps stay
    // off unless asked for, since a dump can hold private text.
    expect(DEFAULT_SETTINGS.analyticsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.errorReportingEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.nativeCrashReportingEnabled).toBe(false);
    expect(reportingConsentOnDisk(path)).toEqual({ errorReportingEnabled: true, nativeCrashReportingEnabled: false });
  });

  it("keep the workflow folder, which defaults to ~/Documents/Anthill and must be absolute", async () => {
    const store = new SettingsStore(path);
    expect((await store.read()).workflowFolder).toBe("");
    expect(workflowFolderPath(await store.read(), "/Users/me")).toBe("/Users/me/Documents/Anthill");

    await store.write({ workflowFolder: "/Users/me/flows" });
    expect((await new SettingsStore(path).read()).workflowFolder).toBe("/Users/me/flows");
    expect(workflowFolderPath(await store.read(), "/Users/me")).toBe("/Users/me/flows");

    await expect(store.write({ workflowFolder: "relative/place" })).rejects.toThrow(/absolute/);
    expect((await store.read()).workflowFolder).toBe("/Users/me/flows");
  });

  it("ignore a folder of the wrong type or a relative one on disk", async () => {
    await writeFile(path, JSON.stringify({ version: SETTINGS_VERSION, settings: { workflowFolder: "rel", stepNotifications: "yes" } }));
    const settings = await new SettingsStore(path).read();
    expect(settings.workflowFolder).toBe("");
    expect(settings.stepNotifications).toBe(false);
  });

  it("gives a version-1 file the new defaults, since its false was only the old default", async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      settings: { stepNotifications: true, analyticsEnabled: false, errorReportingEnabled: false, nativeCrashReportingEnabled: false },
    }));
    expect(reportingConsentOnDisk(path)).toEqual({ errorReportingEnabled: true, nativeCrashReportingEnabled: false });
    const read = await new SettingsStore(path).read();
    expect(read).toMatchObject({ stepNotifications: true, analyticsEnabled: true, errorReportingEnabled: true, nativeCrashReportingEnabled: false });
  });

  it("keeps a choice made from version 2 on, including turning diagnostics off", async () => {
    const store = new SettingsStore(path);
    await store.write({ analyticsEnabled: false, errorReportingEnabled: false });
    expect(reportingConsentOnDisk(path)).toEqual({ errorReportingEnabled: false, nativeCrashReportingEnabled: false });
    expect(await new SettingsStore(path).read()).toMatchObject({ analyticsEnabled: false, errorReportingEnabled: false });
    await store.write({ errorReportingEnabled: true, nativeCrashReportingEnabled: true });
    expect(reportingConsentOnDisk(path)).toEqual({ errorReportingEnabled: true, nativeCrashReportingEnabled: true });
  });

  it("survive a restart", async () => {
    await new SettingsStore(path).write({ stepNotifications: true });
    // A new store over the same file is what a restart looks like from here.
    expect(await new SettingsStore(path).read()).toEqual(on);
  });

  it("can be turned back off, and that survives too", async () => {
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    await store.write({ stepNotifications: false });
    expect(await new SettingsStore(path).read()).toEqual(DEFAULT_SETTINGS);
  });

  it("are patched, so a writer cannot erase a setting it has never heard of", async () => {
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    expect(await store.write({})).toEqual(on);
  });

  it("keep each kind of notification on its own switch", async () => {
    const store = new SettingsStore(path);
    await store.write({ loopNotifications: true, finishedNotifications: true });
    const read = await new SettingsStore(path).read();
    expect(read.loopNotifications).toBe(true);
    expect(read.finishedNotifications).toBe(true);
    expect(read.stepNotifications).toBe(false);
    expect(read.needsYouNotifications).toBe(false);
  });

  it("read a file written before the other switches existed as those switches off", async () => {
    await writeFile(path, JSON.stringify({ version: 1, settings: { stepNotifications: true } }));
    expect(await new SettingsStore(path).read()).toEqual(on);
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
    expect(await new SettingsStore(path).read()).toEqual(DEFAULT_SETTINGS);
  });

  it("is replaced by the next write rather than blocking it", async () => {
    await writeFile(path, "{ not json at all", "utf8");
    const store = new SettingsStore(path);
    await store.write({ stepNotifications: true });
    const written = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(written.version).toBe(SETTINGS_VERSION);
    expect(await new SettingsStore(path).read()).toEqual(on);
  });
});

/**
 * A preference the disk refused (ANT-97).
 *
 * `persist` used to catch and discard, so `write` answered with the new
 * settings as though they were stored. The switch looked accepted until the
 * next launch and then quietly went back.
 */
describe("a write the disk refuses", () => {
  it("says so, rather than answering with settings it did not store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-settings-ro-"));
    const store = new SettingsStore(join(dir, "nested", "settings.json"));
    await store.write({ stepNotifications: true });
    await chmod(join(dir, "nested"), 0o500);

    await expect(store.write({ stepNotifications: false })).rejects.toThrow();

    await chmod(join(dir, "nested"), 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps in memory what is on disk, so the next read is not a lie", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-settings-ro-"));
    const store = new SettingsStore(join(dir, "nested", "settings.json"));
    await store.write({ stepNotifications: true });
    await chmod(join(dir, "nested"), 0o500);

    await store.write({ stepNotifications: false }).catch(() => undefined);

    // Not the value that was refused: what a reader gets has to be what a
    // restart would give them.
    expect((await store.read()).stepNotifications).toBe(true);

    await chmod(join(dir, "nested"), 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not leave the write chain broken for every later write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-settings-ro-"));
    const nested = join(dir, "nested");
    const store = new SettingsStore(join(nested, "settings.json"));
    await store.write({ stepNotifications: true });
    await chmod(nested, 0o500);
    await store.write({ stepNotifications: false }).catch(() => undefined);

    // The failure is reported once. A rejected promise left in the chain would
    // make every later write fail for a reason already dealt with.
    await chmod(nested, 0o700);
    await expect(store.write({ stepNotifications: false })).resolves.toMatchObject({
      stepNotifications: false,
    });

    await rm(dir, { recursive: true, force: true });
  });
});
