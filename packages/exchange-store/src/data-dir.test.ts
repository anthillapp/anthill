/**
 * Finding Anthill's data directory from a process that is not Anthill.
 *
 * Two of the three branches are ones nobody here runs, which is the whole
 * reason the platform is a parameter: a function that read `process.platform`
 * could only ever be checked on macOS, and the Windows answer would be wrong
 * for as long as it took somebody to install it.
 */

import { describe, expect, it } from "vitest";

import { appDataDir, defaultDataDir } from "./data-dir.js";

describe("appDataDir", () => {
  it("answers for macOS", () => {
    expect(appDataDir({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(
      "/Users/ada/Library/Application Support",
    );
  });

  it("answers for Windows, preferring the variable the system sets", () => {
    expect(
      appDataDir({ platform: "win32", home: "C:\\Users\\ada", env: { APPDATA: "C:\\Roaming" } }),
    ).toBe("C:\\Roaming");
    expect(appDataDir({ platform: "win32", home: "/Users/ada", env: {} })).toBe(
      "/Users/ada/AppData/Roaming",
    );
  });

  it("answers for Linux, honouring XDG_CONFIG_HOME", () => {
    expect(appDataDir({ platform: "linux", home: "/home/ada", env: {} })).toBe("/home/ada/.config");
    expect(
      appDataDir({ platform: "linux", home: "/home/ada", env: { XDG_CONFIG_HOME: "/xdg" } }),
    ).toBe("/xdg");
  });
});

describe("defaultDataDir", () => {
  it("lands on the installed app's directory, not the development one", () => {
    expect(defaultDataDir({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(
      "/Users/ada/Library/Application Support/@anthill/desktop",
    );
  });

  it("can be asked for the development app instead", () => {
    expect(
      defaultDataDir({ platform: "darwin", home: "/Users/ada", env: {}, packaged: false }),
    ).toBe("/Users/ada/Library/Application Support/@anthill/desktop-dev");
  });
});
