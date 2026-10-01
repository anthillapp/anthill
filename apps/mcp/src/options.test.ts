/**
 * What the server does with the arguments a harness spawned it with.
 *
 * All of these are about the same hazard from different directions: a server
 * that writes into the wrong directory does not fail, it succeeds quietly
 * against an exchange nobody is reading. So a path given is the path used, a
 * path not given is left to the target, and anything that is neither is
 * refused rather than skipped.
 */

import { describe, expect, it } from "vitest";

import { readOptions } from "./options.js";

describe("readOptions", () => {
  it("leaves the directory and the target to the rule when told nothing", () => {
    expect(readOptions([])).toEqual({ ok: true, options: { launch: true } });
  });

  it("takes the data directory as a separate argument", () => {
    expect(readOptions(["--data-dir", "/var/anthill"])).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: true },
    });
  });

  it("takes the data directory joined with an equals sign", () => {
    expect(readOptions(["--data-dir=/var/anthill"])).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: true },
    });
  });

  it("rejects a relative path rather than choosing an exchange based on harness CWD", () => {
    expect(readOptions(["--data-dir", "./data"]).ok).toBe(false);
  });

  it.each([ ["--data-dir", "  "], ["--data-dir="],
    ["--data-dir=/one", "--data-dir=/two"], ["--data-dir", "/one", "--data-dir", "/one"] ])(
    "rejects empty or repeated data-directory configuration: %j", (...args) => {
      expect(readOptions(args).ok).toBe(false);
    },
  );

  it("refuses a flag with nothing after it rather than falling back", () => {
    expect(readOptions(["--data-dir"]).ok).toBe(false);
  });

  it("refuses a flag whose value is the next flag", () => {
    expect(readOptions(["--data-dir", "--verbose"]).ok).toBe(false);
  });

  it("refuses an argument it does not know, rather than ignoring it", () => {
    // A mistyped flag that were merely skipped would leave the server writing a
    // second, empty exchange beside the real one and reporting every handover
    // as a success.
    const read = readOptions(["--data-dirr", "/var/anthill"]);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("--data-dirr");
  });

  // ANT-123. Handing a workflow over opens Anthill; this is the off switch,
  // and it has to work beside the flag that was already there rather than
  // instead of it.
  it("takes --no-launch, in any order, and defaults to launching", () => {
    expect(readOptions(["--no-launch"])).toEqual({ ok: true, options: { launch: false } });
    expect(readOptions(["--no-launch", "--data-dir", "/var/anthill"])).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: false },
    });
    expect(readOptions(["--data-dir", "/var/anthill", "--no-launch"])).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: false },
    });
  });

  // The whole point of refusing what it does not recognise: a near miss must
  // not read as the flag and leave the app opening anyway.
  it("refuses a misspelt off switch rather than launching quietly", () => {
    const read = readOptions(["--nolaunch"]);
    expect(read.ok).toBe(false);
    expect("message" in read && read.message).toContain("--no-launch");
  });
});

/*
  ANT-222. Which Anthill this plugin copy always serves, said in its own
  .mcp.json. The chat's own --dev and the platform still outrank it; that is
  the target rule's business, tested in target.test.ts.
*/
describe("--target", () => {
  it.each([
    [["--target", "app"], "app"],
    [["--target=web"], "web"],
    [["--target", "electron-dev"], "electron-dev"],
    [["--dev"], "electron-dev"],
    // The spellings the first version of the switch used.
    [["--target", "installed"], "app"],
    [["--target", "dev"], "electron-dev"],
  ])("reads %j as %s", (argv, target) => {
    expect(readOptions(argv)).toEqual({ ok: true, options: { launch: true, target } });
  });

  it("keeps a data directory given beside it, which overrides only the directory", () => {
    expect(readOptions(["--target", "web", "--data-dir", "/var/anthill"])).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: true, target: "web" },
    });
  });

  it.each([[["--target"]], [["--target", "staging"]], [["--target="]]])(
    "refuses %j rather than serving a default", (argv) => {
      const read = readOptions(argv);
      expect(read.ok).toBe(false);
      expect("message" in read && read.message).toContain("app, electron-dev, web");
    },
  );

  it("refuses --dev and a --target that disagree", () => {
    expect(readOptions(["--dev", "--target", "app"]).ok).toBe(false);
    expect(readOptions(["--dev", "--target", "electron-dev"]).ok).toBe(true);
  });
});
