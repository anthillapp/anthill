import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUserDataPath } from "./user-data.js";

describe("desktop data profiles", () => {
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
