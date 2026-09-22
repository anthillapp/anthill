/**
 * The global agent library: reusable profiles that exist before any workflow.
 *
 * The persistence half of ANT-17 — the screens come separately, and nothing
 * here assumes them. A profile describes an *intended* external agent: a name,
 * a model, optionally a role. It does not invoke a model, launch a CLI, or
 * execute anything, and this store gives it exactly the properties the screens
 * will need to be honest about:
 *
 * - **Identity is an issued id, never the name.** Renaming a profile changes
 *   nothing about what references it; ids are minted here, are never accepted
 *   from outside on create, and survive every edit.
 * - **One JSON file in Anthill's own folder**, like the pending runs: nothing
 *   written near the user's projects, nothing sent anywhere.
 * - **Writes are serialized and atomic**, the lesson ANT-7 paid for already:
 *   every write joins one chain and lands whole via a temp file and rename.
 *
 * Deleting a profile that a saved workflow still references is a *screens*
 * concern — the store cannot see every workflow file on disk, and pretending
 * to check would be a promise it cannot keep. The deletion flow owns that
 * question; the store owns remembering things faithfully.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { migrateModels, readAgentModels } from "@anthill/workflow";

import type { GlobalAgentInput, GlobalAgentProfile } from "../shared/ipc.js";

export type { GlobalAgentInput, GlobalAgentProfile };

export class AgentLibraryStore {
  private profiles: GlobalAgentProfile[] = [];
  private loaded = false;
  private loading?: Promise<GlobalAgentProfile[]>;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  /** Beside the library: `global-agents.json` → `global-agents.shipped.json`. */
  private readonly shippedPath: string;

  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.shippedPath = path.replace(/(\.json)?$/, ".shipped.json");
  }

  load(): Promise<GlobalAgentProfile[]> {
    if (this.loaded) return Promise.resolve(this.profiles);
    this.loading ??= this.read();
    return this.loading;
  }

  /**
   * The profiles Anthill ships, written once on a machine that has never had
   * this library.
   *
   * They are ordinary profiles: editable, duplicable, deletable. `starter`
   * only decides which group the list shows them under. Seeding on the file's
   * *absence* rather than on its emptiness is what makes deleting them stick —
   * an author who clears the library has said something, and re-seeding would
   * argue with it.
   */
  private starters(at: string): GlobalAgentProfile[] {
    return [
      {
        id: "agent-starter-architect",
        name: "Architect",
        models: { "claude-code": { id: "opus" } },
        description: "Proposes a design before anything is built.",
        starter: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "agent-starter-adversarial-reviewer",
        name: "Adversarial Reviewer",
        models: { "claude-code": { id: "opus" } },
        description: "Attacks a decision on purpose, so agreement is not mistaken for being right.",
        starter: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "agent-starter-doc-writer",
        name: "Doc writer",
        models: { "claude-code": { id: "haiku" } },
        description: "Writes down what changed, for someone who was not here.",
        starter: true,
        createdAt: at,
        updatedAt: at,
      },
    ];
  }

  /**
   * The ids this machine has already been offered, in a file beside the
   * library.
   *
   * A marker rather than a check of what is present, because the two questions
   * have different answers: "Architect is not in the library" is also true the
   * moment after somebody deletes it, and re-adding it then would argue with
   * them. Offering is the thing that happens once.
   */
  private async offered(): Promise<Set<string>> {
    const text = await readFile(this.shippedPath, "utf8").catch(() => "");
    try {
      const parsed: unknown = text ? JSON.parse(text) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  private async rememberOffered(ids: Set<string>): Promise<void> {
    await mkdir(dirname(this.shippedPath), { recursive: true }).catch(() => undefined);
    const temp = `${this.shippedPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify([...ids], null, 2)}\n`, "utf8");
    await rename(temp, this.shippedPath);
  }

  private async read(): Promise<GlobalAgentProfile[]> {
    const text = await readFile(this.path, "utf8").catch(() => "");
    let parsed: unknown = [];
    try {
      parsed = text ? JSON.parse(text) : [];
    } catch {
      parsed = [];
    }
    const kept = (Array.isArray(parsed) ? (parsed as GlobalAgentProfile[]) : []).filter(
      (item) => typeof item?.id === "string" && typeof item?.name === "string",
    );
    const onDisk = kept.map((item) => this.split(item));
    // Whether reading it changed anything, so a migrated file can be settled
    // rather than re-derived on every start — and so an older shape does not
    // sit beside the current one indefinitely, where the next reader has to
    // decide between them all over again.
    const migrated = JSON.stringify(kept) !== JSON.stringify(onDisk);
    // Anything already in memory arrived while this read was in flight and wins.
    const held = new Set(this.profiles.map((item) => item.id));
    this.profiles = [...this.profiles, ...onDisk.filter((item) => !held.has(item.id))];
    this.loaded = true;
    this.loading = undefined;

    // Written back before seeding, and separately from it: the two are
    // different reasons to touch the file and one failing should not take the
    // other with it.
    if (migrated) await this.flush().catch(() => undefined);
    await this.seed();
    return this.profiles;
  }

  /**
   * Put the shipped profiles in, once each, ever.
   *
   * Keyed on what this machine has been *offered*, not on the library being
   * empty. Seeding on an absent file was wrong for everyone who already had a
   * library: they had written their own profiles before these existed, so the
   * file was there, and the shipped three were never offered to the people
   * most likely to want them. Keyed this way a new profile can also be added
   * in a later version and reach an existing library, without any of the ones
   * already deleted coming back.
   */
  private async seed(): Promise<void> {
    const offered = await this.offered();
    const shipped = this.starters(this.now());
    const missing = shipped.filter((item) => !offered.has(item.id));
    if (missing.length === 0) return;

    // A profile the author has renamed or rewritten is theirs now; the id
    // being present is enough to say it was offered.
    const held = new Set(this.profiles.map((item) => item.id));
    const fresh = missing.filter((item) => !held.has(item.id));
    if (fresh.length > 0) {
      this.profiles = [...this.profiles, ...fresh];
      await this.flush();
    }
    await this.rememberOffered(new Set([...offered, ...missing.map((item) => item.id)])).catch(
      // The library is written; a marker that did not land only costs a repeat
      // of this on the next start, which adds nothing twice.
      () => undefined,
    );
  }

  /**
   * A profile from before the model was split by harness, in the new shape.
   *
   * On the way in, so exactly one shape reaches the rest of the program and a
   * file is rewritten in it by the next ordinary save. Deterministic and
   * machine-independent: an id exactly one harness offers is placed under it,
   * and anything else is carried verbatim for a person to answer rather than
   * assigned to a guess. The library file may be the same file on two
   * computers, and both have to make the same decision about it.
   */
  private split(item: GlobalAgentProfile): GlobalAgentProfile {
    const older = (item as { model?: unknown }).model;
    const { model: _drop, ...rest } = item as GlobalAgentProfile & { model?: unknown };

    const stored = readAgentModels(item.models);
    if (stored) return { ...rest, models: stored };

    const migrated = migrateModels(item.models ?? older);
    const { models: _also, ...bare } = rest;
    return {
      ...bare,
      ...(Object.keys(migrated.models).length > 0 ? { models: migrated.models } : {}),
      ...(migrated.needsReview ? { modelNeedsReview: migrated.needsReview } : {}),
    };
  }

  all(): GlobalAgentProfile[] {
    return this.profiles;
  }

  find(id: string): GlobalAgentProfile | undefined {
    return this.profiles.find((item) => item.id === id);
  }

  async create(input: GlobalAgentInput): Promise<GlobalAgentProfile> {
    await this.load();
    const at = this.now();
    const profile: GlobalAgentProfile = {
      id: `agent-${randomUUID()}`,
      // Kept as given, empty included. "Unnamed agent" is what an empty name
      // *reads* as, which is the display layer's business; storing it here
      // would make a placeholder indistinguishable from a name somebody chose.
      // A trailing space typed by the author is part of the name, not noise:
      // the trim belongs at the read/display boundary, not on the way in.
      name: input.name,
      ...(input.models && Object.keys(input.models).length > 0 ? { models: input.models } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.description ? { description: input.description } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.profiles = [profile, ...this.profiles];
    await this.flush();
    return profile;
  }

  /**
   * Update everything but the id and createdAt, which are not anyone's to change.
   *
   * The three optional fields can be *cleared*, and clearing them removes the
   * key rather than storing an empty string: a profile carrying `role: ""`
   * would answer "yes, it has a role" to everything downstream that only
   * checks whether the field is there. Emptying a field is a real edit, so
   * "not mentioned" and "mentioned as empty" have to mean different things.
   */
  async update(id: string, input: Partial<GlobalAgentInput>): Promise<GlobalAgentProfile | undefined> {
    await this.load();
    const current = this.find(id);
    if (!current) return undefined;
    const next: GlobalAgentProfile = {
      ...current,
      // Kept as given, empty included (see `create`): a trailing space is part
      // of the name, so it is stored rather than trimmed on the way in.
      ...(input.name !== undefined ? { name: input.name } : {}),
      updatedAt: this.now(),
    };
    // `undefined` is "not mentioned"; `""` is "clear it". The two used to be
    // the same answer, which made an edit's blast radius depend on which keys
    // the caller happened to spell out — and every caller crosses IPC, where a
    // key with no value arrives looking exactly like one that was meant.
    if (input.models !== undefined) {
      // Answering the model question at all settles the migration's open one,
      // so the value awaiting review goes with it.
      delete next.modelNeedsReview;
      if (Object.keys(input.models).length === 0) delete next.models;
      else next.models = input.models;
    }
    for (const key of ["role", "description"] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (value.trim().length === 0) delete next[key];
      else next[key] = value;
    }
    this.profiles = this.profiles.map((item) => (item.id === id ? next : item));
    await this.flush();
    return next;
  }

  /** A copy with its own identity — "Name (copy)", new id, new clock. */
  async duplicate(id: string): Promise<GlobalAgentProfile | undefined> {
    await this.load();
    const source = this.find(id);
    if (!source) return undefined;
    return this.create({
      name: `${source.name} (copy)`,
      ...(source.models ? { models: source.models } : {}),
      ...(source.role ? { role: source.role } : {}),
      ...(source.description ? { description: source.description } : {}),
    });
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((item) => item.id !== id);
    if (this.profiles.length === before) return false;
    await this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    if (this.loading) return;
    const snapshot = JSON.stringify(this.profiles, null, 2);
    this.writing = this.writing.then(() => this.persist(snapshot));
    await this.writing;
  }

  private async persist(snapshot: string): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      this.writeSeq += 1;
      const temp = `${this.path}.${process.pid}.${this.writeSeq}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.path);
    } catch {
      // Losing the record is better than taking the app down.
    }
  }
}
