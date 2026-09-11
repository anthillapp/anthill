/**
 * The CLI's argument parsing: `--flag value` and `--flag=value`, the defaults,
 * and the errors (an unknown argument, a missing value, a bad port).
 */

import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to the loopback, port 4173, and a browser", () => {
    expect(parseArgs([])).toEqual({
      port: 4173,
      host: "127.0.0.1",
      openBrowser: true,
      workspace: undefined,
      dataDir: undefined,
    });
  });

  it("reads --port / --host / --workspace / --data-dir as `flag value`", () => {
    expect(
      parseArgs(["--port", "8080", "--host", "0.0.0.0", "--workspace", "/w", "--data-dir", "/d"]),
    ).toEqual({
      port: 8080,
      host: "0.0.0.0",
      openBrowser: true,
      workspace: "/w",
      dataDir: "/d",
    });
  });

  it("reads `flag=value`", () => {
    expect(parseArgs(["--port=9090", "--host=127.0.0.1"])).toMatchObject({
      port: 9090,
      host: "127.0.0.1",
    });
  });

  it("turns --no-browser off", () => {
    expect(parseArgs(["--no-browser"]).openBrowser).toBe(false);
  });
});
