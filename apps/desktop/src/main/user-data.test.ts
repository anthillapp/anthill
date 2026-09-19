import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUserDataPath, desktopDataDirectory } from "./user-data.js";

describe("desktop data profiles", () => {
  it("accepts an explicit local profile and refuses ambiguous overrides", () => {
    expect(desktopDataDirectory(["--data-dir", "/tmp/qa"], "/default")).toBe("/tmp/qa");
    expect(desktopDataDirectory(["--data-dir=/tmp/qa"], "/default")).toBe("/tmp/qa");
    expect(desktopDataDirectory([], "/default")).toBe("/default");
    for (const args of [["--data-dir"], ["--data-dir", "relative"], ["--data-dir=/one", "--data-dir=/two"]]) {
      expect(() => desktopDataDirectory(args, "/default")).toThrow();
    }
  });
  const appData = join("/test", "Library", "Application Support");

  it("preserves the installed app's existing data location", () => {
    expect(desktopUserDataPath(appData, true)).toBe(join(appData, "@anthill", "desktop"));
  });

  it("isolates development stores and the Electron instance lock", () => {
    const development = desktopUserDataPath(appData, false);
    const installed = desktopUserDataPath(appData, true);
    expect(development).toBe(join(appData, "@anthill", "desktop-dev"));
    for (const store of ["SingletonLock", "global-agents.json", "recent-workflows.json", "live-sessions.json", "live-observations", "live-observation-setup.json", "runs"]) {
      expect(join(development, store)).not.toBe(join(installed, store));
    }
  });
});
