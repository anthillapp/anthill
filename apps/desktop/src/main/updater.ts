/**
 * Updating Anthill from GitHub Releases (ANT-76).
 *
 * The release workflow publishes, next to the disk image, the zip and
 * `latest-mac.yml` that electron-updater reads. This file is what turns that
 * into something a person can see and decide about: whether there is a newer
 * release, downloading it when they say so, and restarting into it when they
 * say so. Nothing here downloads or restarts on its own; an automatic check
 * only finds out, and the menu bar and Settings ▸ About say what it found.
 *
 * Split in two so the part with the decisions can be tested without Electron:
 *
 * - `UpdateController` is the state machine. It owns what the screen shows,
 *   what each button may do in each state, and how a failure is said.
 * - `electronUpdateSource` is the thin adapter over electron-updater and
 *   Squirrel.Mac, the native updater that actually swaps the app.
 *
 * **Verified means Squirrel said so.** electron-updater checks the download
 * against the sha512 in `latest-mac.yml`, then hands the zip to Squirrel.Mac,
 * which checks that the new app is signed by the same developer as the one
 * running. Only after that does the update count as ready. A build signed by
 * anybody else, or not signed at all, is refused there, and the screen offers
 * the download page instead.
 */

import type { UpdateErrorKind, UpdateFailedDuring, UpdateState, UpdateStatus } from "../shared/ipc.js";

export type UpdateFound = {
  version: string;
  releaseDate?: string;
  releaseName?: string;
};

export type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
};

/** What the controller needs from electron-updater. A fake in tests. */
export interface UpdateSource {
  /** The newer release, or `null` when the installed one is the latest. */
  check(): Promise<UpdateFound | null>;
  /**
   * Download the release `check` found and stage it.
   *
   * Resolves only once the update is verified and ready to install; rejects
   * on any failure, and on `signal` aborting.
   */
  download(onProgress: (progress: UpdateProgress) => void, signal: AbortSignal): Promise<void>;
  /** Quit, swap the app, and open the new one. */
  install(): void;
}

/**
 * Asks the person whether restarting now is all right, given what is open.
 * `true` means go ahead.
 */
export type RestartGuard = () => Promise<boolean>;

export type UpdateControllerOptions = {
  /** The version running now. */
  current: string;
  /**
   * Why this build cannot update itself, when it cannot: a development run,
   * or a system the release does not cover. Nothing is checked then.
   */
  unavailable?: string;
  source?: UpdateSource;
  /**
   * Why the app cannot be replaced where it is, if it cannot — checked
   * before a download starts rather than discovered after it finishes.
   */
  installBlocker?: () => string | undefined;
  guard: RestartGuard;
  onChange?: (status: UpdateStatus) => void;
  now?: () => Date;
};

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancellationError";
  }
}

export class UpdateController {
  private state: UpdateState;
  private downloading?: AbortController;

  constructor(private readonly options: UpdateControllerOptions) {
    this.state = options.unavailable || !options.source
      ? { phase: "unavailable", reason: options.unavailable ?? "This build of Anthill cannot update itself." }
      : { phase: "idle" };
  }

  status(): UpdateStatus {
    return { current: this.options.current, state: this.state };
  }

  /**
   * Ask GitHub whether there is a newer release.
   *
   * A `background` check is the one Anthill makes by itself. Its failure is
   * nobody's problem — the person did not ask, may well be offline, and an
   * error waiting on Settings ▸ About for a question they never put would be
   * noise — so it leaves the screen as it was.
   */
  async check({ background = false }: { background?: boolean } = {}): Promise<UpdateStatus> {
    const { source } = this.options;
    if (!source) return this.status();
    // Nothing to ask while a download is under way or one is waiting to be
    // installed: the answer could only be the release already in hand.
    if (["checking", "downloading", "ready"].includes(this.state.phase)) return this.status();
    const before = this.state;
    this.set({ phase: "checking" });
    try {
      const found = await source.check();
      this.set(
        found
          ? {
              phase: "available",
              version: found.version,
              ...(found.releaseDate ? { releaseDate: found.releaseDate } : {}),
              ...(found.releaseName ? { releaseName: found.releaseName } : {}),
            }
          : { phase: "current", checkedAt: (this.options.now?.() ?? new Date()).toISOString() },
      );
    } catch (error) {
      this.set(background ? before : failed(error, "check"));
    }
    return this.status();
  }

  /** Download the release a check found. Only after the person asked for it. */
  async download(): Promise<UpdateStatus> {
    const { source } = this.options;
    const version = this.state.phase === "available" ||
      (this.state.phase === "failed" && this.state.during === "download")
      ? this.state.version
      : undefined;
    if (!source || !version) return this.status();

    const blocked = this.options.installBlocker?.();
    if (blocked) {
      this.set({ phase: "failed", during: "download", version, kind: "location", message: blocked, retryable: true });
      return this.status();
    }

    const controller = new AbortController();
    this.downloading = controller;
    this.set({ phase: "downloading", version, percent: 0, transferred: 0, total: 0 });
    try {
      await source.download((progress) => {
        if (this.downloading !== controller) return;
        this.set({
          phase: "downloading",
          version,
          percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
          transferred: progress.transferred,
          total: progress.total,
        });
      }, controller.signal);
      if (controller.signal.aborted) throw new Cancelled();
      this.set({ phase: "ready", version });
    } catch (error) {
      // Cancelling is not a failure: the release is still there to take.
      this.set(
        controller.signal.aborted || isCancellation(error)
          ? { phase: "available", version }
          : failed(error, "download", version),
      );
    } finally {
      if (this.downloading === controller) this.downloading = undefined;
    }
    return this.status();
  }

  /** Stop a download in progress. The release stays on offer. */
  cancel(): UpdateStatus {
    this.downloading?.abort();
    return this.status();
  }

  /**
   * Restart into the downloaded release, once the person has agreed to
   * whatever restarting would interrupt.
   */
  async install(): Promise<UpdateStatus> {
    const { source } = this.options;
    if (!source || this.state.phase !== "ready") return this.status();
    const { version } = this.state;
    if (!(await this.options.guard())) return this.status();
    try {
      source.install();
    } catch (error) {
      this.set(failed(error, "install", version));
    }
    return this.status();
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.options.onChange?.(this.status());
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "CancellationError" || /^cancell?ed$/i.test(error.message));
}

function failed(error: unknown, during: UpdateFailedDuring, version?: string): UpdateState {
  const { kind, message, retryable } = describeUpdateError(error);
  return { phase: "failed", during, kind, message, retryable, ...(version ? { version } : {}) };
}

/**
 * What went wrong, in words a person can act on.
 *
 * The errors come from three layers — Node's network stack, electron-updater
 * and Squirrel.Mac — and none of them is written for the person reading
 * Settings. They are recognised by their codes where there are codes and by
 * their wording where there are not; anything unrecognised keeps its own
 * first line, since a vague sentence of ours would hide the one clue there is.
 */
export function describeUpdateError(error: unknown): {
  kind: UpdateErrorKind;
  message: string;
  retryable: boolean;
} {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : "";
  const status = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const text = typeof record.message === "string" ? record.message : String(error ?? "");

  if (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"].includes(code) ||
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE)/.test(text)
  ) {
    return {
      kind: "offline",
      message: "Anthill couldn't reach GitHub. Check your connection and try again.",
      retryable: true,
    };
  }
  // Before the rate limit: a checksum is a long run of characters, and the
  // two numbers in it could look like anything.
  if (code === "ERR_CHECKSUM_MISMATCH" || /checksum mismatch/i.test(text)) {
    return {
      kind: "integrity",
      message: "The download didn't match the release's checksum, so it was thrown away. Try again.",
      retryable: true,
    };
  }
  if (status === 429 || /rate limit|\b429 Too Many/i.test(text)) {
    return {
      kind: "rate-limited",
      message: "GitHub is limiting requests from this network right now. Try again in a little while.",
      retryable: true,
    };
  }
  if (code === "ENOSPC" || /no space left/i.test(text)) {
    return {
      kind: "disk",
      message: "There isn't enough free disk space for the update. Free some space and try again.",
      retryable: true,
    };
  }
  if (/read-only|AppTranslocation/i.test(text)) {
    return {
      kind: "location",
      message: LOCATION_MESSAGE,
      retryable: true,
    };
  }
  if (/code ?sign|signature|did not pass validation|designated requirement/i.test(text)) {
    return {
      kind: "signature",
      message: "macOS couldn't confirm the update is signed by Anthill's developer, so it wasn't installed. Download the new version from GitHub instead.",
      retryable: false,
    };
  }
  if (
    ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_UPDATER_INVALID_RELEASE_FEED", "ERR_UPDATER_ZIP_FILE_NOT_FOUND"].includes(code)
  ) {
    return {
      kind: "no-release",
      message: "This release can't be installed from here. Download it from GitHub instead.",
      retryable: false,
    };
  }
  const first = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  return {
    kind: "unknown",
    message: first ? `The update didn't finish: ${first.length > 160 ? `${first.slice(0, 157)}…` : first}` : "The update didn't finish.",
    retryable: true,
  };
}

const LOCATION_MESSAGE =
  "Anthill can't replace itself where it is now. Move Anthill to your Applications folder, open it from there, and try again.";

/**
 * Why the app at this path cannot be swapped for a new one, if it cannot.
 *
 * macOS runs an app opened straight from a download out of a randomised,
 * read-only copy ("App Translocation"), and one opened from the disk image
 * out of the image itself. Squirrel can replace neither, and would say so only
 * after the whole download.
 */
export function installBlocker(executablePath: string): string | undefined {
  if (executablePath.includes("/AppTranslocation/") || executablePath.startsWith("/Volumes/")) {
    return LOCATION_MESSAGE;
  }
  return undefined;
}

/** What the app menu offers for updates, given where they stand. */
export function updateMenuItem(status: UpdateStatus): {
  label: string;
  action: "check" | "open" | "install";
} {
  const { state } = status;
  switch (state.phase) {
    case "available":
      return { label: `Update to Anthill ${state.version}…`, action: "open" };
    case "downloading":
      return { label: `Downloading Anthill ${state.version}…`, action: "open" };
    case "ready":
      return { label: `Restart to Update to ${state.version}`, action: "install" };
    default:
      return { label: "Check for Updates…", action: "check" };
  }
}

/** How often Anthill asks GitHub by itself, after the first look at launch. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Long enough after launch not to compete with opening the window. */
export const FIRST_UPDATE_CHECK_DELAY_MS = 10_000;

/* ------------------------------------------------------------------ */
/* electron-updater                                                    */
/* ------------------------------------------------------------------ */

type Listener = (...args: unknown[]) => void;

/** The parts of electron-updater's `autoUpdater` used here. */
export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string; releaseDate?: string; releaseName?: string | null } } | null>;
  downloadUpdate(cancellationToken?: unknown): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};

/** Electron's own `autoUpdater` — Squirrel.Mac — which electron-updater feeds. */
export type NativeUpdaterLike = {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};

/**
 * electron-updater, set up the way this app uses it.
 *
 * - **Nothing automatic.** No download until asked; a downloaded update is
 *   installed on the next quit as well as by Restart to Update, because a
 *   person who downloaded it wants it and quitting is a restart they chose.
 * - **Stable releases only**, never a downgrade.
 * - **An `error` listener always.** electron-updater is an EventEmitter, and
 *   an `error` with nobody listening throws from wherever it was emitted —
 *   which for a failed background check is the middle of nowhere.
 */
export function electronUpdateSource(
  updater: AutoUpdaterLike,
  native: NativeUpdaterLike,
  newCancellationToken: () => { cancel(): void },
): UpdateSource {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = null;
  updater.on("error", () => undefined);

  return {
    async check() {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      const { version, releaseDate, releaseName } = result.updateInfo;
      return {
        version,
        ...(releaseDate ? { releaseDate } : {}),
        ...(releaseName ? { releaseName } : {}),
      };
    },

    download(onProgress, signal) {
      return new Promise<void>((resolve, reject) => {
        const token = newCancellationToken();
        const progress = ((info: { percent?: number; transferred?: number; total?: number }) =>
          onProgress({
            percent: info.percent ?? 0,
            transferred: info.transferred ?? 0,
            total: info.total ?? 0,
          })) as Listener;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          updater.removeListener("download-progress", progress);
          native.removeListener("update-downloaded", staged);
          native.removeListener("error", refused);
          signal.removeEventListener("abort", abort);
          if (error === undefined) resolve();
          else reject(error);
        };
        // Squirrel has checked the signature and staged the new app: the
        // one moment the update is really ready.
        const staged = (() => finish()) as Listener;
        const refused = ((error: unknown) => finish(error ?? new Error("The update was refused."))) as Listener;
        const abort = () => {
          token.cancel();
          finish(new Cancelled());
        };
        updater.on("download-progress", progress);
        native.on("update-downloaded", staged);
        native.on("error", refused);
        signal.addEventListener("abort", abort, { once: true });
        updater.downloadUpdate(token).catch((error: unknown) => finish(error));
      });
    },

    install() {
      // Not silent, and the new version opens once it is in place.
      updater.quitAndInstall(false, true);
    },
  };
}
