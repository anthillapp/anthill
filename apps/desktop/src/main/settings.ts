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
import { dirname, isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

/** Bumped when the file's shape changes. A version this one cannot read is defaulted. */
export const SETTINGS_VERSION = 2;

/**
 * Version 1 wrote every setting at its default, and the diagnostics defaults
 * were off. A `false` in a version-1 file is therefore the old default, not a
 * choice anybody is known to have made, so it takes the new default. From
 * version 2 on, whatever is stored is the person's answer.
 */
const DIAGNOSTICS_DEFAULTED_IN_V1 = ["analyticsEnabled", "errorReportingEnabled", "nativeCrashReportingEnabled"] as const;

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
  /** Anonymous, content-free product analytics. On by default; one switch turns it off. */
  analyticsEnabled: boolean;
  /** JavaScript error reports. On by default. Applied at the next launch. */
  errorReportingEnabled: boolean;
  /**
   * Native memory dumps. On by default like the rest of diagnostics, and a
   * switch of its own because a dump can carry private text from memory.
   * Needs error reports; applied at the next launch.
   */
  nativeCrashReportingEnabled: boolean;
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
  /**
   * Where the save dialog opens for a workflow never saved before: an absolute
   * path, or empty for `~/Documents/Anthill`. Only the starting folder of a
   * first save — nothing already saved is moved, and a saved workflow keeps
   * saving where it is.
   */
  workflowFolder: string;
};

export const DEFAULT_SETTINGS: Settings = {
  analyticsEnabled: true,
  errorReportingEnabled: true,
  nativeCrashReportingEnabled: true,
  stepNotifications: false,
  stepFinishedNotifications: false,
  loopNotifications: false,
  needsYouNotifications: false,
  finishedNotifications: false,
  observationLostNotifications: false,
  workflowFolder: "",
};

/** The folder a first save opens in: the one chosen, or `~/Documents/Anthill`. */
export function workflowFolderPath(settings: Pick<Settings, "workflowFolder">, home: string): string {
  return settings.workflowFolder && isAbsolute(settings.workflowFolder)
    ? settings.workflowFolder
    : join(home, "Documents", "Anthill");
}

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
  if (!isRecord(value) || (value.version !== SETTINGS_VERSION && value.version !== 1)) return { ...DEFAULT_SETTINGS };
  const stored: Record<string, unknown> = isRecord(value.settings) ? { ...value.settings } : {};
  if (value.version === 1) for (const key of DIAGNOSTICS_DEFAULTED_IN_V1) delete stored[key];
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    // Each value only in the type its default has: a string where a switch
    // belongs, or the reverse, is a value this version does not understand.
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) {
      (settings as Record<string, unknown>)[key] = stored[key];
    }
  }
  if (settings.workflowFolder && !isAbsolute(settings.workflowFolder)) settings.workflowFolder = "";
  return settings;
}

/** Read only launch consent before Electron's ready event, as Sentry requires. */
export function reportingConsentOnDisk(path: string): Pick<Settings, "errorReportingEnabled" | "nativeCrashReportingEnabled"> {
  try {
    const settings = parse(readFileSync(path, "utf8"));
    return {
      errorReportingEnabled: settings.errorReportingEnabled,
      nativeCrashReportingEnabled: settings.nativeCrashReportingEnabled,
    };
  } catch {
    // No file yet is a first launch, which gets the defaults like everything else.
    return {
      errorReportingEnabled: DEFAULT_SETTINGS.errorReportingEnabled,
      nativeCrashReportingEnabled: DEFAULT_SETTINGS.nativeCrashReportingEnabled,
    };
  }
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
    // A folder has to be a real absolute path, or empty for the default; the
    // renderer cannot set the save dialog loose on a relative one.
    if (patch.workflowFolder !== undefined && patch.workflowFolder !== "" && !isAbsolute(patch.workflowFolder)) {
      throw new Error("The workflow folder has to be an absolute path.");
    }
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
