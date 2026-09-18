/**
 * The preferences Anthill keeps for this machine.
 *
 * One small file, read once and written whole. It exists because a preference
 * that does not survive a restart is not a preference — the author said
 * something, and the app has to still know it tomorrow.
 *
 * Everything here has a documented default, and the default is what an
 * unreadable, missing or newer file falls back to. That is deliberate for this
 * particular setting: notifications are off unless someone asked for them, so
 * the failure mode of a damaged file is silence rather than an app that starts
 * interrupting because it could not read its own record.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Bumped when the file's shape changes. A version this one cannot read is defaulted. */
export const SETTINGS_VERSION = 1;

export type Settings = {
  /**
   * Whether a confidently observed move to a new workflow step raises a
   * native notification.
   *
   * **Off by default.** Anthill's whole posture is that it watches without
   * getting in the way, and a notification is the one thing it does that
   * reaches past its own window. Someone has to ask for that.
   */
  stepNotifications: boolean;
};

export const DEFAULT_SETTINGS: Settings = { stepNotifications: false };

type Stored = { version: number; settings: Settings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the file into settings this version understands.
 *
 * Field by field rather than wholesale, so one unrecognised value costs that
 * value and not the rest of the file.
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
  return {
    stepNotifications:
      typeof stored.stepNotifications === "boolean"
        ? stored.stepNotifications
        : DEFAULT_SETTINGS.stepNotifications,
  };
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
    const current = await this.read();
    this.settings = { ...current, ...patch };
    await this.flush();
    return { ...this.settings };
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: SETTINGS_VERSION, settings: this.settings ?? DEFAULT_SETTINGS } satisfies Stored,
      null,
      2,
    );
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
      // Losing a preference is better than taking the app down for it.
    }
  }
}
