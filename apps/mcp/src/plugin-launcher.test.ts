/**
 * Each plugin's launcher is told its harness by its own `.mcp.json`.
 *
 * The manifest folder cannot say it: more than one harness reads
 * `.claude-plugin`. So `.mcp.json` passes `--host <harness>`, and the launcher
 * hands it to the server in the environment and keeps it out of the server's
 * arguments, which refuse flags they do not know.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PLUGIN_HARNESSES, PLUGIN_HARNESS_INFO } from "@anthill/workflow";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type Seen = { args: string[]; host: string | null; version: string | null };

/** Start a plugin's launcher against a stand-in server that reports what it was given. */
async function launch(folder: string, args: string[]): Promise<Seen> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-plugin-launcher-"));
  const server = join(dir, "server.mjs");
  writeFileSync(
    server,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), " +
      "host: process.env.ANTHILL_PLUGIN_HOST ?? null, version: process.env.ANTHILL_PLUGIN_VERSION ?? null }));\n",
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHILL_MCP_SERVER: server };
  delete env.ANTHILL_PLUGIN_HOST;
  delete env.ANTHILL_PLUGIN_VERSION;
  const child = spawn(process.execPath, [join(ROOT, folder, "bin/anthill-mcp"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout) as Seen;
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, any>;
}

describe("the plugin launcher", () => {
  for (const id of PLUGIN_HARNESSES) {
    const { folder, manifest } = PLUGIN_HARNESS_INFO[id];

    it(`is told it runs in ${id} by ${folder}/.mcp.json`, async () => {
      const declared = (json(`${folder}/.mcp.json`).mcpServers.exchange.args as string[])
        .filter((arg) => !arg.endsWith("/bin/anthill-mcp"));
      expect(declared).toEqual(["--host", id]);

      const seen = await launch(folder, [...declared, "--data-dir", "/tmp/anthill-data"]);
      expect(seen).toEqual({
        args: ["--data-dir", "/tmp/anthill-data"],
        host: id,
        version: json(`${folder}/${manifest}`).version,
      });
    });
  }

  it("takes the --host=<harness> spelling too", async () => {
    const seen = await launch(PLUGIN_HARNESS_INFO.codex.folder, ["--host=codex"]);
    expect(seen).toMatchObject({ args: [], host: "codex" });
  });

  it("names no harness when none is given, rather than guessing one from the manifest", async () => {
    const seen = await launch(PLUGIN_HARNESS_INFO["claude-code"].folder, []);
    expect(seen.args).toEqual([]);
    expect(seen.host).toBeNull();
    expect(seen.version).toBe(json(`${PLUGIN_HARNESS_INFO["claude-code"].folder}/.claude-plugin/plugin.json`).version);
  });
});
