/**
 * The preferences Anthill keeps for this machine.
 *
 * One small file, read once and written whole. It exists because a preference
 * that does not survive a restart is not a preference — the author said
 * something, and the app has to still know it tomorrow.
 *
 * Everything here has a documented default, and the default is what an
 * unreadable, missing or newer file falls back to. That is deliberate for these
 * particular settings: notifications are off unless someone asked for them, so
 * the failure mode of a damaged file is silence rather than an app that starts
 * interrupting because it could not read its own record.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Bumped when the file's shape changes. A version this one cannot read is defaulted. */
export const SETTINGS_VERSION = 1;

/**
 * Which moments of an observed session raise a native notification.
 *
 * **All off by default.** Anthill's whole posture is that it watches without
 * getting in the way, and a notification is the one thing it does that
 * reaches past its own window. Someone has to ask for each of these, and
 * each is asked for on its own: the person who wants to know when a step
 * starts is not necessarily the person who wants to be told every time a
 * loop comes round (ANT-132).
 *
 * `stepNotifications` keeps its old name, so a preference set before the
 * others existed still means what it meant: a confidently observed move to
 * a new step.
 */
export type Settings = {
  /** A step the session announced it is starting. */
  stepNotifications: boolean;
  /** A step the session left, which is as finished as Anthill can say. */
  stepFinishedNotifications: boolean;
  /** A step announced again — a loop coming back round. */
  loopNotifications: boolean;
  /** The CLI recorded that it is waiting for a person. */
  needsYouNotifications: boolean;
  /** The session finished, or the record says it failed. */
  finishedNotifications: boolean;
  /** Anthill can no longer read the session. */
  observationLostNotifications: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  stepNotifications: false,
  stepFinishedNotifications: false,
  loopNotifications: false,
  needsYouNotifications: false,
  finishedNotifications: false,
  observationLostNotifications: false,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

type Stored = { version: number; settings: Settings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the file into settings this version understands.
 *
 * Field by field rather than wholesale, so one unrecognised value costs that
 * value and not the rest of the file — and a file written before a setting
 * existed simply has that setting at its default.
 */
function parse(text: string): Settings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!isRecord(value) || value.version !== SETTINGS_VERSION) return { ...DEFAULT_SETTINGS };
  const stored = isRecord(value.settings) ? value.settings : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (typeof stored[key] === "boolean") settings[key] = stored[key];
  }
  return settings;
}

export class SettingsStore {
  private settings?: Settings;
  private loading?: Promise<Settings>;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  constructor(private readonly path: string) {}

  /** What the author has asked for, defaults filled in. */
  read(): Promise<Settings> {
    if (this.settings) return Promise.resolve({ ...this.settings });
    this.loading ??= readFile(this.path, "utf8").then(
      (text) => (this.settings = parse(text)),
      // No file yet, or one this process cannot read. The defaults are the
      // answer either way; a preference nobody has expressed is the default.
      () => (this.settings = { ...DEFAULT_SETTINGS }),
    );
    return this.loading.then((settings) => ({ ...settings }));
  }

  /**
   * Change some of the settings, and say what they now are.
   *
   * A patch rather than a replacement, so a renderer that knows about one
   * setting cannot erase another it has never heard of.
   */
  async write(patch: Partial<Settings>): Promise<Settings> {
    const written = this.writing.then(async () => {
      const next = { ...await this.read(), ...patch };
      await this.persist(JSON.stringify({ version: SETTINGS_VERSION, settings: next } satisfies Stored, null, 2));
      // Publish only durable settings. Serializing the entire update also
      // prevents a failed earlier write from rolling back a later success.
      this.settings = next;
      return { ...next };
    });
    this.writing = written.then(() => undefined, () => undefined);
    return written;
  }

  /**
   * One write: whole file to a temp name, then rename over.
   *
   * A failure is raised rather than swallowed. It used to be caught here on
   * the grounds that losing a preference is better than taking the app down —
   * true, and the wrong place to act on it. The catch made `write` return the
   * new settings as though they were stored, so a switch the disk had refused
   * stayed on until the next launch and then quietly went back (ANT-97).
   *
   * Nothing is taken down: the caller reports it, and the switch stays where
   * the user actually left it.
   */
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
