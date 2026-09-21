import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = resolve(ROOT, "plugins/anthill-cli");

function text(path: string): string {
  return readFileSync(resolve(PLUGIN, path), "utf8");
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(text(path)) as Record<string, unknown>;
}

describe("the Codex plugin package", () => {
  it("declares one native skill and the shared local exchange server", () => {
    const manifest = json(".codex-plugin/plugin.json");
    const packageJson = json("package.json");
    const mcp = json(".mcp.json") as {
      mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; cwd?: string }>;
    };

    expect(manifest).toMatchObject({
      name: "anthill-cli",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    expect(packageJson).toMatchObject({ private: true, type: "module" });
    expect(mcp.mcpServers?.exchange).toEqual({
      type: "stdio",
      command: "./bin/anthill-mcp",
      args: [],
      cwd: ".",
    });
  });

  it("uses Codex identity and the ANT-86 contract without runner semantics", () => {
    const skill = text("skills/anthill/SKILL.md");
    const skillUi = text("skills/anthill/agents/openai.yaml");

    expect(skill).toContain("name: anthill");
    expect(skill).toContain("$anthill");
    expect(skillUi).toContain('display_name: "Anthill CLI: Use Workflow"');
    expect(skillUi).toContain('default_prompt: "Use $anthill');
    expect(skill).toContain("CODEX_SESSION_ID");
    expect(skill).toMatch(/do not submit\s+or bind a workflow/);
    expect(skill).toContain('source.harness: "codex"');
    expect(skill).toContain('target: "codex"');
    expect(skill).toContain("create_workflow_draft");
    expect(skill).toContain("get_ready_revision");
    expect(skill).toContain("bind_run");
    expect(skill).toContain("anthill step <run-id> <nonce> <block-id>");
    expect(skill).toContain("request the narrow local permission");
    expect(skill).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(skill).not.toContain("continue without `sessionId`");
    expect(skill).not.toContain("Anthill runs Codex");
  });

  it("ships the same defensive MCP launcher as the Claude Code package", () => {
    const codex = text("bin/anthill-mcp");
    const claude = readFileSync(resolve(ROOT, "plugins/anthill/bin/anthill-mcp"), "utf8");
    expect(codex).toBe(claude);
  });

  it("starts the MCP server from a standalone installed-plugin layout", async () => {
    const home = await mkdtemp(join(tmpdir(), "anthill-cli-plugin-"));
    const installed = join(home, "plugin");
    cpSync(PLUGIN, installed, { recursive: true });
    mkdirSync(join(home, ".anthill"));
    writeFileSync(
      join(home, ".anthill", "plugin.json"),
      JSON.stringify({ server: resolve(ROOT, "apps/mcp/dist/server.js") }),
    );

    const child = spawn(process.execPath, [join(installed, "bin/anthill-mcp")], {
      cwd: installed,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "installed-layout-test", version: "1" },
      },
    })}\n`);

    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "anthill" } },
    });
  });

  it("documents Codex as the workflow target", () => {
    const reference = text("skills/anthill/reference/workflow-format.md");
    expect(reference).toContain('"target": "codex"');
    expect(reference).toContain("must be `codex` when Codex is the one submitting");
    expect(reference).toContain('"models": { "codex": { "id": "__default__" } }');
    expect(reference).toContain("`report` are arrays of strings");
    expect(reference).not.toContain('"target": "claude-code"');
  });
});
