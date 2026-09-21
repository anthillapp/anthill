import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the CLI package", () => {
  it("emits and executes the CLI as ESM", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { type?: string };
    const tsconfig = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { module?: string; moduleResolution?: string } };

    expect(packageJson.type).toBe("module");
    expect(tsconfig.compilerOptions).toMatchObject({
      module: "ESNext",
      moduleResolution: "Bundler",
    });

    const help = execFileSync(
      process.execPath,
      [resolve(PACKAGE_ROOT, "out/cli/src/cli.js"), "--help"],
      { encoding: "utf8" },
    );
    expect(help).toContain("anthill step <runId> <nonce> <stepId>");
  });
});
