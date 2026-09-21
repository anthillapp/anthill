/**
 * What the server does with the arguments a harness spawned it with.
 *
 * All of these are about the same hazard from different directions: a server
 * that writes into the wrong directory does not fail, it succeeds quietly
 * against an exchange nobody is reading. So a path given is the path used, a
 * path not given is the app's own, and anything that is neither is refused
 * rather than skipped.
 */

import { describe, expect, it } from "vitest";

import { readOptions } from "./options.js";

const FALLBACK = "/tmp/anthill-fallback";

describe("readOptions", () => {
  it("falls back to the app's own data directory when told nothing", () => {
    const read = readOptions([], FALLBACK);

    expect(read).toEqual({ ok: true, options: { dataDir: FALLBACK, launch: true } });
  });

  it("takes the data directory as a separate argument", () => {
    const read = readOptions(["--data-dir", "/var/anthill"], FALLBACK);

    expect(read).toEqual({ ok: true, options: { dataDir: "/var/anthill", launch: true } });
  });

  it("takes the data directory joined with an equals sign", () => {
    const read = readOptions(["--data-dir=/var/anthill"], FALLBACK);

    expect(read).toEqual({ ok: true, options: { dataDir: "/var/anthill", launch: true } });
  });

  it("rejects a relative path rather than choosing an exchange based on harness CWD", () => {
    const read = readOptions(["--data-dir", "./data"], FALLBACK);

    expect(read.ok).toBe(false);
  });

  it.each([ ["--data-dir", "  "], ["--data-dir="],
    ["--data-dir=/one", "--data-dir=/two"], ["--data-dir", "/one", "--data-dir", "/one"] ])(
    "rejects empty or repeated data-directory configuration: %j", (...args) => {
      expect(readOptions(args, FALLBACK).ok).toBe(false);
    },
  );

  it("refuses a flag with nothing after it rather than falling back", () => {
    const read = readOptions(["--data-dir"], FALLBACK);

    expect(read.ok).toBe(false);
  });

  it("refuses a flag whose value is the next flag", () => {
    const read = readOptions(["--data-dir", "--verbose"], FALLBACK);

    expect(read.ok).toBe(false);
  });

  it("refuses an argument it does not know, rather than ignoring it", () => {
    // A mistyped flag that were merely skipped would leave the server writing a
    // second, empty exchange beside the real one and reporting every handover
    // as a success.
    const read = readOptions(["--data-dirr", "/var/anthill"], FALLBACK);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("--data-dirr");
  });

  // ANT-123. Handing a workflow over opens Anthill; this is the off switch,
  // and it has to work beside the flag that was already there rather than
  // instead of it.
  it("takes --no-launch, in any order, and defaults to launching", () => {
    expect(readOptions(["--no-launch"], FALLBACK)).toEqual({
      ok: true, options: { dataDir: FALLBACK, launch: false },
    });
    expect(readOptions(["--no-launch", "--data-dir", "/var/anthill"], FALLBACK)).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: false },
    });
    expect(readOptions(["--data-dir", "/var/anthill", "--no-launch"], FALLBACK)).toEqual({
      ok: true, options: { dataDir: "/var/anthill", launch: false },
    });
  });

  // The whole point of refusing what it does not recognise: a near miss must
  // not read as the flag and leave the app opening anyway.
  it("refuses a misspelt off switch rather than launching quietly", () => {
    const read = readOptions(["--nolaunch"], FALLBACK);
    expect(read.ok).toBe(false);
    expect("message" in read && read.message).toContain("--no-launch");
  });
});
