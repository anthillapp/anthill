/**
 * Every place Anthill writes its version says the same thing.
 *
 * ANT-120. The marketplace entry sat at 0.7.0 from its first day while the
 * plugin manifest beside it reached 0.7.6, and the skill's frontmatter stopped
 * at 0.7.3 — nothing checked, and `claude plugin tag` already calls the first
 * of those an error. `npm run version:set` writes them all; this fails if
 * anything writes one of them by hand.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;
}

const release = String(json("package.json").version);

describe("the version Anthill says it is", () => {
  it("is one version across every workspace package", () => {
    const paths = ["apps", "packages"].flatMap((group) =>
      readdirSync(join(ROOT, group))
        .map((name) => join(group, name, "package.json"))
        .filter((path) => existsSync(join(ROOT, path))),
    );
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) expect(json(path).version, path).toBe(release);
  });

  it("is the Claude Code plugin's version, and its marketplace entry agrees", () => {
    expect(json("plugins/anthill/.claude-plugin/plugin.json").version).toBe(release);
    const marketplace = json(".claude-plugin/marketplace.json") as {
      plugins: { name: string; version?: string }[];
    };
    const entry = marketplace.plugins.find((plugin) => plugin.name === "anthill");
    expect(entry?.version).toBe(release);
  });

  it("is the version the Claude Code skill's frontmatter names", () => {
    const skill = readFileSync(join(ROOT, "plugins/anthill/skills/workflow/SKILL.md"), "utf8");
    expect(/^version:\s*(\S+)\s*$/m.exec(skill)?.[1]).toBe(release);
  });

  it("is the Codex plugin's version, before its build suffix", () => {
    const version = String(json("plugins/anthill-cli/.codex-plugin/plugin.json").version);
    expect(version.split("+")[0]).toBe(release);
  });
});
