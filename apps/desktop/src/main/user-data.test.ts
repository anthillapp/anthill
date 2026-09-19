import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirectoryRefusal, desktopUserDataPath, desktopDataDirectory } from "./user-data.js";

describe("desktop data profiles", () => {
  it("accepts an explicit local profile and refuses ambiguous overrides", () => {
    expect(desktopDataDirectory(["--data-dir", "/tmp/qa"], "/default")).toBe("/tmp/qa");
    expect(desktopDataDirectory(["--data-dir=/tmp/qa"], "/default")).toBe("/tmp/qa");
    expect(desktopDataDirectory([], "/default")).toBe("/default");
    for (const args of [["--data-dir"], ["--data-dir", "relative"], ["--data-dir=/one", "--data-dir=/two"]]) {
      expect(() => desktopDataDirectory(args, "/default")).toThrow();
    }
  });

  /*
   * A refusal here happens before there is a window, so the sentence is the
   * whole of what the person gets. Every one of these argument shapes killed
   * the app outright with nothing printed anywhere.
   */
  it("names the flag, what it was given and where Anthill would otherwise look", () => {
    for (const [args, expected] of [
      [["--data-dir=./profile"], '"./profile"'],
      [["--data-dir"], "(nothing)"],
      [["--data-dir", "--verbose"], '"--verbose"'],
      [["--data-dir=/one", "--data-dir=/two"], '"/two"'],
    ] as const) {
      let refusal = "";
      try {
        desktopDataDirectory([...args], "/default");
      } catch (error) {
        refusal = dataDirectoryRefusal(error, "/Users/someone/Library/Application Support/@anthill/desktop");
      }
      expect(refusal).toContain("--data-dir");
      expect(refusal).toContain(expected);
      expect(refusal).toContain("/Users/someone/Library/Application Support/@anthill/desktop");
    }
  });

  /* The filesystem's own message already names the path; it must survive. */
  it("passes on what the filesystem said about a directory it would not create", () => {
    const refusal = dataDirectoryRefusal(
      new Error("EACCES: permission denied, mkdir '/locked/profile'"),
      "/default",
    );
    expect(refusal).toContain("/locked/profile");
    expect(refusal).toContain("/default");
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
