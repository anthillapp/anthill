/**
 * The VS Code plugin package, as VS Code reads it.
 *
 * VS Code takes several plugin formats and picks one by which files are there
 * (src/vs/platform/agentPlugins/common/pluginParsers.ts): a root `plugin.json`
 * with the agent-plugins.org `$schema` is the strict format, which expands no
 * plugin root in `.mcp.json`; `.claude-plugin/plugin.json` would be read as a
 * Claude Code plugin; a plain root `plugin.json` is VS Code's own. And of a
 * repository's marketplace files it reads the first that lists plugins, with
 * `.github/plugin/marketplace.json` ahead of `.claude-plugin/marketplace.json`,
 * which is the only one Claude Code reads. Both plugins are named `anthill`, so
 * each tool has to find its own file and never the other's.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/anthill-vscode");

function text(path: string): string {
  return readFileSync(join(PLUGIN, path), "utf8");
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, any>;
}

describe("the VS Code plugin package", () => {
  it("is in VS Code's own format, which expands the plugin root", () => {
    const manifest = json("plugins/anthill-vscode/plugin.json");
    expect(manifest).toMatchObject({ name: "anthill", skills: "./skills/" });
    expect(manifest).not.toHaveProperty("$schema");
    expect(existsSync(join(PLUGIN, ".claude-plugin"))).toBe(false);
    expect(existsSync(join(PLUGIN, ".plugin"))).toBe(false);
  });

  it("starts the shared launcher and tells it the harness is vscode", () => {
    expect(json("plugins/anthill-vscode/.mcp.json").mcpServers.exchange).toEqual({
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/bin/anthill-mcp", "--host", "vscode"],
    });
    expect(text("bin/anthill-mcp")).toBe(readFileSync(join(ROOT, "plugins/anthill-claude/bin/anthill-mcp"), "utf8"));
  });

  it("offers one skill, /anthill:workflow, whose folder is its name", () => {
    const skill = text("skills/workflow/SKILL.md");
    expect(/^name:\s*(\S+)\s*$/m.exec(skill)?.[1]).toBe("workflow");
    expect(skill).toContain("user-invocable: true");
  });

  it("hands over as vscode, under an id it makes for the chat", () => {
    const skill = text("skills/workflow/SKILL.md");
    expect(skill).toContain('`harness: "vscode"`');
    expect(skill).toContain('"models": { "vscode": { "id": "__default__" } }');
    expect(skill).toContain("node -e \"console.log('vscode-' + crypto.randomUUID())\"");
    expect(skill).not.toMatch(/CLAUDE_CODE_SESSION_ID|CODEX_SESSION_ID|claude-code/);
    // VS Code passes no arguments into a skill's text.
    expect(skill).not.toContain("$ARGUMENTS");
  });

  it("documents VS Code as the workflow target", () => {
    const reference = text("skills/workflow/reference/workflow-format.md");
    expect(reference).toContain('"target": "vscode"');
    expect(reference).toContain("must be `vscode` when VS Code is the one submitting");
    expect(reference).not.toContain("claude-code");
  });
});

describe("the marketplaces", () => {
  it("offer VS Code its own plugin from .github/plugin/marketplace.json", () => {
    const marketplace = json(".github/plugin/marketplace.json");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "anthill", source: "./plugins/anthill-vscode" }),
    ]);
  });

  it("leave Claude Code's file listing only the Claude Code plugin", () => {
    const marketplace = json(".claude-plugin/marketplace.json");
    expect(marketplace.plugins.map((plugin: { source: string }) => plugin.source)).toEqual(["./plugins/anthill-claude"]);
  });

  it("put nothing VS Code would read ahead of its own file", () => {
    expect(existsSync(join(ROOT, "marketplace.json"))).toBe(false);
    expect(existsSync(join(ROOT, ".plugin", "marketplace.json"))).toBe(false);
  });
});
