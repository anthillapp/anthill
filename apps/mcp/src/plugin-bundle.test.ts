/**
 * A plugin installed from a marketplace or a directory starts its own server.
 *
 * What it gets is a copy of its folder and nothing else: no checkout, no
 * ~/.anthill/plugin.json, no ANTHILL_* variables. The launcher then has only
 * the server the plugin carries (server/anthill-mcp.mjs), and this starts each
 * plugin that way and speaks to it as a harness would.
 *
 * The copy goes under the system's temporary directory, which on macOS is
 * reached through a symlink: a server that compared its path as given took
 * itself for an import there and exited without answering.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const release = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

async function initializeInstalledCopy(plugin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), "anthill-plugin-bundle-"));
  const installed = join(home, "plugin");
  cpSync(join(ROOT, plugin), installed, { recursive: true });
  mkdirSync(join(home, "data"));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.ANTHILL_MCP_SERVER;
  delete env.ANTHILL_REPO;

  const child = spawn(process.execPath, [join(installed, "bin/anthill-mcp"), "--data-dir", join(home, "data")], {
    cwd: installed,
    env,
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
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-test", version: "1" } },
  })}\n`);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  return { code, stdout, stderr };
}

describe("a plugin installed on its own", () => {
  for (const plugin of ["plugins/anthill", "plugins/anthill-cli"]) {
    it(`starts the server ${plugin} carries, with nothing configured`, async () => {
      const { code, stdout, stderr } = await initializeInstalledCopy(plugin);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "anthill", version: release } },
      });
    });
  }
});
