/**
 * The CLI on Windows: warned, never refused (ANT-154).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLATFORM_HELP, platformWarning } from "./platform.js";

describe("the Windows warning", () => {
  it("says unsupported, may fail, where to report, and that it carries on", () => {
    const warning = platformWarning("win32")!;
    expect(warning).toMatch(/experimental and unsupported/);
    expect(warning).toMatch(/some commands and integrations may fail/);
    expect(warning).toMatch(/issues\/new\?template=windows\.yml/);
    expect(warning).toMatch(/Carrying on anyway/);
  });

  it("says nothing on macOS or Linux", () => {
    expect(platformWarning("darwin")).toBeUndefined();
    expect(platformWarning("linux")).toBeUndefined();
  });

  it("is never followed by an exit because of the platform", () => {
    // The entry point prints the warning and goes on; nothing in it exits on
    // the operating system alone.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
    expect(source).toContain("platformWarning()");
    expect(source).not.toMatch(/win32[^\n]*process\.exit|process\.exit[^\n]*win32/);
  });

  it("puts the same platform words in --help that About and the README use", () => {
    expect(PLATFORM_HELP).toBe(
      "Platforms: macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon – building from source is possible for experimentation, but Windows is not yet officially supported and some features may not work.",
    );
  });
});
