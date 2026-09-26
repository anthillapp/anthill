/**
 * Where the author's model preferences live on disk (ANT-135).
 *
 * Its own file rather than a key in `settings.json`, because that store is
 * deliberately a set of switches: it reads booleans and nothing else, and
 * teaching it nested data would loosen the one parser that has to be strict.
 * This file holds structure — per-tool lists, per-tier mappings — and is read
 * through `readModelPreferences`, which keeps what is sound and drops what is
 * not, field by field.
 *
 * Written the same way the settings are: the whole file to a temporary name,
 * then renamed over, one write at a time, and a failure raised to the caller
 * rather than swallowed — a preference the disk refused must not look saved.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readModelPreferences, type ModelPreferences } from "@anthill/workflow";

export const MODEL_PREFERENCES_VERSION = 1;

export class ModelPreferencesStore {
  private current?: ModelPreferences;
  private loading?: Promise<ModelPreferences>;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  constructor(private readonly path: string) {}

  read(): Promise<ModelPreferences> {
    if (this.current) return Promise.resolve(structuredClone(this.current));
    this.loading ??= readFile(this.path, "utf8").then(
      (text) => (this.current = parse(text)),
      // No file yet is the ordinary case: nobody has said anything.
      () => (this.current = readModelPreferences(undefined)),
    );
    return this.loading.then((value) => structuredClone(value));
  }

  /**
   * Replace the preferences with these, normalised on the way in.
   *
   * A whole value rather than a patch: the page edits one structure, and a
   * patch of nested lists would need its own merge rules for no gain.
   */
  async write(next: unknown): Promise<ModelPreferences> {
    const written = this.writing.then(async () => {
      const value = readModelPreferences(next);
      await this.persist(JSON.stringify({ version: MODEL_PREFERENCES_VERSION, preferences: value }, null, 2));
      this.current = value;
      return structuredClone(value);
    });
    this.writing = written.then(() => undefined, () => undefined);
    return written;
  }

  private async persist(snapshot: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.writeSeq += 1;
    const temp = `${this.path}.${process.pid}.${this.writeSeq}.tmp`;
    try {
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

function parse(text: string): ModelPreferences {
  try {
    const value = JSON.parse(text) as { version?: unknown; preferences?: unknown };
    // A file from a version this build does not know is not read as though it
    // were this one: guessing at its shape could turn a preference into its
    // opposite. The defaults are shown instead.
    if (value?.version !== MODEL_PREFERENCES_VERSION) return readModelPreferences(undefined);
    return readModelPreferences(value.preferences);
  } catch {
    return readModelPreferences(undefined);
  }
}
