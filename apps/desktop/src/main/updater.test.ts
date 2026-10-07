/**
 * Updating Anthill (ANT-76): the decisions, without Electron.
 *
 * The controller is driven through a fake source, so each state the screen
 * can show is reached the way it is in the app, and each refusal is checked
 * for what it leaves behind. The adapter is driven through fake emitters
 * standing in for electron-updater and Squirrel.Mac, because "ready" has to
 * mean Squirrel verified it, not merely that bytes arrived.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { UpdateStatus } from "../shared/ipc.js";
import {
  describeUpdateError,
  electronUpdateSource,
  installBlocker,
  UpdateController,
  updateMenuItem,
  type AutoUpdaterLike,
  type UpdateProgress,
  type UpdateSource,
} from "./updater.js";

type Fake = UpdateSource & {
  found: { version: string; releaseDate?: string } | null;
  checkError?: unknown;
  downloadError?: unknown;
  progress?: UpdateProgress[];
  installs: number;
  /** Resolves the pending download, if the test holds it open. */
  release?: () => void;
  hold: boolean;
};

function fakeSource(overrides: Partial<Fake> = {}): Fake {
  const source: Fake = {
    found: { version: "0.9.0", releaseDate: "2026-10-05T00:00:00.000Z" },
    installs: 0,
    hold: false,
    async check() {
      if (source.checkError) throw source.checkError;
      return source.found;
    },
    download(onProgress, signal) {
      for (const step of source.progress ?? []) onProgress(step);
      if (source.downloadError) return Promise.reject(source.downloadError);
      if (!source.hold) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        source.release = resolve;
        signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "CancellationError";
          reject(error);
        });
      });
    },
    install() {
      source.installs += 1;
    },
    ...overrides,
  };
  return source;
}

function controller(source: UpdateSource | undefined, options: Partial<ConstructorParameters<typeof UpdateController>[0]> = {}) {
  const seen: UpdateStatus[] = [];
  const guard = vi.fn(async () => true);
  const updates = new UpdateController({
    current: "0.8.9",
    ...(source ? { source } : {}),
    guard,
    onChange: (status) => seen.push(status),
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    ...options,
  });
  return { updates, seen, guard };
}

describe("checking", () => {
  it("offers the newer release it finds, with its date", async () => {
    const { updates } = controller(fakeSource());
    const status = await updates.check();
    expect(status).toEqual({
      current: "0.8.9",
      state: { phase: "available", version: "0.9.0", releaseDate: "2026-10-05T00:00:00.000Z" },
    });
  });

  it("says the installed version is the latest when there is nothing newer", async () => {
    const { updates } = controller(fakeSource({ found: null }));
    expect((await updates.check()).state).toEqual({ phase: "current", checkedAt: "2026-10-05T12:00:00.000Z" });
  });

  it("shows Checking while it asks", async () => {
    const { updates, seen } = controller(fakeSource());
    await updates.check();
    expect(seen.map((status) => status.state.phase)).toEqual(["checking", "available"]);
  });

  it("says what went wrong when the person asked", async () => {
    const offline = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    const { updates } = controller(fakeSource({ checkError: offline }));
    expect((await updates.check()).state).toMatchObject({ phase: "failed", during: "check", kind: "offline", retryable: true });
  });

  it("keeps quiet about a check nobody asked for", async () => {
    const { updates } = controller(fakeSource({ checkError: new Error("net::ERR_INTERNET_DISCONNECTED") }));
    expect((await updates.check({ background: true })).state).toEqual({ phase: "idle" });
  });

  it("does not ask again while a download is under way or waiting to install", async () => {
    const source = fakeSource({ hold: true });
    const check = vi.spyOn(source, "check");
    const { updates } = controller(source);
    await updates.check();
    const downloading = updates.download();
    await updates.check({ background: true });
    source.release?.();
    await downloading;
    await updates.check();
    expect(check).toHaveBeenCalledTimes(1);
    expect(updates.status().state.phase).toBe("ready");
  });

  it("does nothing at all in a build that cannot update itself", async () => {
    const { updates } = controller(undefined, { unavailable: "This is a development build." });
    expect(updates.status().state).toEqual({ phase: "unavailable", reason: "This is a development build." });
    expect((await updates.check()).state.phase).toBe("unavailable");
    expect((await updates.download()).state.phase).toBe("unavailable");
    expect((await updates.install()).state.phase).toBe("unavailable");
  });
});

describe("downloading", () => {
  it("is ready only once the source has verified and staged it", async () => {
    const source = fakeSource({ progress: [{ percent: 41.6, transferred: 41, total: 100 }] });
    const { updates, seen } = controller(source);
    await updates.check();
    const status = await updates.download();
    expect(seen.map((item) => item.state)).toContainEqual({
      phase: "downloading",
      version: "0.9.0",
      percent: 42,
      transferred: 41,
      total: 100,
    });
    expect(status.state).toEqual({ phase: "ready", version: "0.9.0" });
  });

  it("does not start without a release on offer", async () => {
    const source = fakeSource();
    const download = vi.spyOn(source, "download");
    const { updates } = controller(source);
    await updates.download();
    expect(download).not.toHaveBeenCalled();
    expect(updates.status().state.phase).toBe("idle");
  });

  it("goes back to the offer when cancelled, which is not a failure", async () => {
    const { updates } = controller(fakeSource({ hold: true }));
    await updates.check();
    const downloading = updates.download();
    expect(updates.status().state.phase).toBe("downloading");
    updates.cancel();
    expect((await downloading).state).toEqual({ phase: "available", version: "0.9.0" });
  });

  it("throws a corrupt download away and lets it be tried again", async () => {
    const corrupt = Object.assign(new Error("sha512 checksum mismatch, expected abc, got def"), {
      code: "ERR_CHECKSUM_MISMATCH",
    });
    const source = fakeSource({ downloadError: corrupt });
    const { updates } = controller(source);
    await updates.check();
    expect((await updates.download()).state).toMatchObject({
      phase: "failed",
      during: "download",
      kind: "integrity",
      retryable: true,
      version: "0.9.0",
    });
    source.downloadError = undefined;
    expect((await updates.download()).state).toEqual({ phase: "ready", version: "0.9.0" });
  });

  it("refuses an update macOS will not accept, and sends the person to GitHub", async () => {
    const refused = new Error("Code signature at URL file:///… did not pass validation: code failed to satisfy specified code requirement(s)");
    const { updates } = controller(fakeSource({ downloadError: refused }));
    await updates.check();
    expect((await updates.download()).state).toMatchObject({ phase: "failed", kind: "signature", retryable: false });
  });

  it("says so before downloading when the app cannot be replaced where it is", async () => {
    const source = fakeSource();
    const download = vi.spyOn(source, "download");
    const { updates } = controller(source, {
      installBlocker: () => installBlocker("/private/var/folders/x/AppTranslocation/ABC/d/Anthill.app/Contents/MacOS/Anthill"),
    });
    await updates.check();
    expect((await updates.download()).state).toMatchObject({ phase: "failed", kind: "location", during: "download" });
    expect(download).not.toHaveBeenCalled();
  });
});

describe("installing", () => {
  async function ready(source = fakeSource(), guard?: () => Promise<boolean>) {
    const made = controller(source, guard ? { guard } : {});
    await made.updates.check();
    await made.updates.download();
    return { ...made, source };
  }

  it("restarts into the release once the person agrees", async () => {
    const { updates, source, guard } = await ready();
    await updates.install();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(source.installs).toBe(1);
  });

  it("stays ready when the person would rather not interrupt what is open", async () => {
    const { updates, source } = await ready(fakeSource(), async () => false);
    expect((await updates.install()).state).toEqual({ phase: "ready", version: "0.9.0" });
    expect(source.installs).toBe(0);
  });

  it("does not ask or install before there is anything downloaded", async () => {
    const source = fakeSource();
    const { updates, guard } = controller(source);
    await updates.check();
    await updates.install();
    expect(guard).not.toHaveBeenCalled();
    expect(source.installs).toBe(0);
  });

  it("reports an install that fails to start, with the release it was for", async () => {
    const source = fakeSource();
    source.install = () => {
      throw new Error("Cannot update while running on a read-only volume");
    };
    const { updates } = await ready(source);
    expect((await updates.install()).state).toMatchObject({
      phase: "failed",
      during: "install",
      kind: "location",
      version: "0.9.0",
    });
  });
});

describe("what a failure says", () => {
  it.each([
    [{ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, "offline", true],
    [{ message: "net::ERR_NAME_NOT_RESOLVED" }, "offline", true],
    [{ statusCode: 403, message: "HttpError: 403 Forbidden\n\"API rate limit exceeded for 1.2.3.4\"" }, "rate-limited", true],
    [{ statusCode: 429, message: "HttpError: 429" }, "rate-limited", true],
    [{ code: "ERR_CHECKSUM_MISMATCH", message: "sha512 checksum mismatch, expected 4290a, got b" }, "integrity", true],
    [{ code: "ENOSPC", message: "ENOSPC: no space left on device, write" }, "disk", true],
    [{ message: "Cannot update while running on a read-only volume" }, "location", true],
    [{ message: "Code signature did not pass validation" }, "signature", false],
    [{ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", message: "Cannot find latest-mac.yml" }, "no-release", false],
  ])("%j is %s", (error, kind, retryable) => {
    expect(describeUpdateError(error)).toMatchObject({ kind, retryable });
  });

  it("keeps the first line of anything it does not recognise, and no stack", () => {
    const described = describeUpdateError(new Error("Squirrel exploded\n    at somewhere (file.js:1:1)"));
    expect(described).toEqual({ kind: "unknown", message: "The update didn't finish: Squirrel exploded", retryable: true });
  });
});

describe("where the app is running from", () => {
  it("cannot be replaced from a translocated copy or the disk image", () => {
    expect(installBlocker("/private/var/folders/ab/AppTranslocation/1234/d/Anthill.app/Contents/MacOS/Anthill")).toBeDefined();
    expect(installBlocker("/Volumes/Anthill 0.8.9/Anthill.app/Contents/MacOS/Anthill")).toBeDefined();
  });

  it("can be from Applications, in either place", () => {
    expect(installBlocker("/Applications/Anthill.app/Contents/MacOS/Anthill")).toBeUndefined();
    expect(installBlocker("/Users/me/Applications/Anthill.app/Contents/MacOS/Anthill")).toBeUndefined();
  });
});

describe("the menu item", () => {
  const status = (state: UpdateStatus["state"]): UpdateStatus => ({ current: "0.8.9", state });

  it("checks when there is nothing found yet", () => {
    expect(updateMenuItem(status({ phase: "idle" }))).toEqual({ label: "Check for Updates…", action: "check" });
    expect(updateMenuItem(status({ phase: "current", checkedAt: "x" })).action).toBe("check");
  });

  it("names a release found in the background, so it shows without opening anything", () => {
    expect(updateMenuItem(status({ phase: "available", version: "0.9.0" }))).toEqual({
      label: "Update to Anthill 0.9.0…",
      action: "open",
    });
  });

  it("restarts from the menu once the release is ready", () => {
    expect(updateMenuItem(status({ phase: "ready", version: "0.9.0" }))).toEqual({
      label: "Restart to Update to 0.9.0",
      action: "install",
    });
  });
});

describe("electron-updater, as wired", () => {
  function fakes() {
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      allowDowngrade: true,
      logger: console as unknown,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
    });
    const native = new EventEmitter();
    const tokens: { cancelled: boolean; cancel(): void }[] = [];
    const source = electronUpdateSource(updater as unknown as AutoUpdaterLike, native, () => {
      const token = { cancelled: false, cancel() { token.cancelled = true; } };
      tokens.push(token);
      return token;
    });
    return { updater, native, source, tokens };
  }

  it("downloads only when asked, takes stable releases and never goes back", () => {
    const { updater } = fakes();
    expect(updater.autoDownload).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("always listens for errors, so an unheard one cannot throw", () => {
    const { updater } = fakes();
    expect(() => updater.emit("error", new Error("background check failed"))).not.toThrow();
  });

  it("reports a release only when electron-updater says it is newer", async () => {
    const { updater, source } = fakes();
    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: "0.8.9" } });
    expect(await source.check()).toBeNull();
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "0.9.0", releaseDate: "2026-10-05", releaseName: null },
    });
    expect(await source.check()).toEqual({ version: "0.9.0", releaseDate: "2026-10-05" });
  });

  it("is ready when Squirrel has staged it, not when the bytes arrived", async () => {
    const { updater, native, source } = fakes();
    const progress: UpdateProgress[] = [];
    let done = false;
    const downloading = source.download((step) => progress.push(step), new AbortController().signal).then(() => {
      done = true;
    });
    updater.emit("download-progress", { percent: 50, transferred: 5, total: 10 });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    native.emit("update-downloaded");
    await downloading;
    expect(progress).toEqual([{ percent: 50, transferred: 5, total: 10 }]);
    expect(updater.listenerCount("download-progress")).toBe(0);
  });

  it("fails when Squirrel refuses the update", async () => {
    const { native, source } = fakes();
    const downloading = source.download(() => undefined, new AbortController().signal);
    native.emit("error", new Error("Code signature did not pass validation"));
    await expect(downloading).rejects.toThrow(/did not pass validation/);
    expect(native.listenerCount("error")).toBe(0);
  });

  it("cancels electron-updater's download when aborted", async () => {
    const { source, tokens } = fakes();
    const abort = new AbortController();
    const downloading = source.download(() => undefined, abort.signal);
    abort.abort();
    await expect(downloading).rejects.toMatchObject({ name: "CancellationError" });
    expect(tokens[0]?.cancelled).toBe(true);
  });

  it("restarts into the new version rather than only quitting", () => {
    const { updater, source } = fakes();
    source.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
