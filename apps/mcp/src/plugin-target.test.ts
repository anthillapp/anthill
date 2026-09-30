/**
 * ANT-226. `npm run plugin:target`, run for real against a temporary home.
 *
 * Two promises are tested. The file is the user's, so a switch changes
 * `"target"` and nothing else in it. And the status is the server's own
 * answer: it is computed here with `resolveTarget` from the same inputs and
 * compared, so a script that disagreed with the server about where handovers
 * go would fail rather than mislead a QA run.
 *
 * Every run passes `--no-build`, or picks `app`, which builds nothing: the
 * suite's own build is what the script finds beside the server.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveTarget, targetDataDir, type Target, type TargetEnvironment } from "./target.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "plugin-target.mjs");
const SERVER = join(ROOT, "apps", "mcp", "dist", "server.js");

type Run = { code: number; stdout: string; stderr: string };

async function home(): Promise<{ home: string; environment: TargetEnvironment; settings: string }> {
  const home = await mkdtemp(join(tmpdir(), "anthill-plugin-target-"));
  // Everything the data directories are derived from, pinned to the temporary
  // home so neither the script nor the comparison can see the real ones.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  delete env.npm_execpath;
  delete env.ANTHILL_MCP_SERVER;
  delete env.ANTHILL_REPO;
  return { home, environment: { platform: process.platform, home, env }, settings: join(home, ".anthill", "plugin.json") };
}

function run(environment: TargetEnvironment, ...args: string[]): Promise<Run> {
  return runWith(environment, {}, ...args);
}

function runWith(environment: TargetEnvironment, extra: Record<string, string>, ...args: string[]): Promise<Run> {
  return new Promise((settle) => {
    const env = { ...environment.env, ...extra } as NodeJS.ProcessEnv;
    execFile(process.execPath, [SCRIPT, ...args], { env, cwd: environment.home }, (error, stdout, stderr) => {
      settle({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

async function status(environment: TargetEnvironment): Promise<Record<string, unknown>> {
  const result = await run(environment, "--json");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** What the server started from that file would resolve, asked of the server's own code. */
function serverSays(environment: TargetEnvironment, setting?: Target) {
  const resolution = resolveTarget({ ...environment, ...(setting ? { setting } : {}), checkout: ROOT });
  if (!resolution.ok) throw new Error(resolution.message);
  const { target, source, label, dataDir } = resolution.resolved;
  return { target, source, label, dataDir };
}

describe("npm run plugin:target", () => {
  it("reports what the server resolves when nothing is set", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER }));
    const said = await status(environment);

    expect(said).toMatchObject({ ok: true, ...serverSays(environment), setting: null, server: SERVER, checkout: ROOT, warnings: [] });
  });

  it.each([
    ["electron-dev", "electron-dev"],
    ["dev", "electron-dev"],
    ["web", "web"],
  ] as const)("%s writes \"target\": %j, keeps every other field, and reports what the server resolves", async (argument, target) => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER, telemetry: { off: true }, note: "mine" }));

    const result = await run(environment, argument, "--no-build", "--json");

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({
      server: SERVER, telemetry: { off: true }, note: "mine", target,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ...serverSays(environment, target), setting: target });
  });

  it.each(["app", "installed"])("%s removes \"target\" and nothing else", async (argument) => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER, target: "dev", note: "mine" }));

    const result = await run(environment, argument, "--json");

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ server: SERVER, note: "mine" });
    expect(JSON.parse(result.stdout)).toMatchObject({ ...serverSays(environment), setting: null });
  });

  it("names this checkout's server only when the file names none", async () => {
    const { environment, settings } = await home();

    expect((await run(environment, "electron-dev", "--no-build")).code).toBe(0);

    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ server: SERVER, target: "electron-dev" });
  });

  it("says a web shell is running, and on which port", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER }));
    const dir = targetDataDir("web", environment);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instance.lock"), JSON.stringify({ pid: process.pid, port: 4873, host: "127.0.0.1" }));

    const said = await status(environment);

    expect(said.running).toMatchObject({ web: { host: "127.0.0.1", port: 4873 } });
    if (process.platform === "darwin") expect(said.running).toMatchObject({ app: false, "electron-dev": false });
  });

  it("refuses a damaged file and leaves it as it was", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, "{ not json");

    const result = await run(environment, "web", "--no-build");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(await readFile(settings, "utf8")).toBe("{ not json");
  });

  it("prints the usage for --help and succeeds", async () => {
    const { environment } = await home();
    const result = await run(environment, "--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("app | electron-dev | web");
  });

  it.each([["staging"], ["web", "app"], ["web", "--nobuild"]])("refuses %j with the usage", async (...args) => {
    const { environment, settings } = await home();

    const result = await run(environment, ...args);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("app | electron-dev | web");
    await expect(readFile(settings, "utf8")).rejects.toThrow();
  });
});

/*
  Written out, rather than asked of resolveTarget, so a resolver and a script
  that were wrong the same way would still fail here.
*/
describe("where plugin:target says handovers go", () => {
  it("names the data directory of each target on this platform", async () => {
    const { environment, home: root } = await home();
    const macOS = join(root, "Library", "Application Support", "@anthill");
    const expected: Record<Target, { target: Target; dataDir: string }> = process.platform === "darwin"
      ? {
          app: { target: "app", dataDir: join(macOS, "desktop") },
          "electron-dev": { target: "electron-dev", dataDir: join(macOS, "desktop-dev") },
          web: { target: "web", dataDir: join(root, ".anthill", "cli") },
        }
      : {
          app: { target: "web", dataDir: join(root, ".anthill", "cli") },
          "electron-dev": { target: "web", dataDir: join(root, ".anthill", "cli") },
          web: { target: "web", dataDir: join(root, ".anthill", "cli") },
        };
    for (const target of ["app", "electron-dev", "web"] as const) {
      const result = await run(environment, target, "--no-build", "--json");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(expected[target]);
    }
  });
});

/*
  The ways the status could disagree with what the plugins actually start:
  the launcher's own order of places to find the server, and the files it
  refuses.
*/
describe("the server plugin:target reports", () => {
  it("is the one ANTHILL_REPO names, as the launcher would start it, with a warning", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: "/nowhere/server.js" }));

    const result = await runWith(environment, { ANTHILL_REPO: ROOT }, "--json");

    expect(result.code).toBe(0);
    const said = JSON.parse(result.stdout) as { server: string; serverFrom: string; warnings: string[] };
    expect(said).toMatchObject({ server: SERVER, serverFrom: "ANTHILL_REPO" });
    expect(said.warnings.join(" ")).toContain("ANTHILL_REPO");
  });

  it("is refused when ANTHILL_MCP_SERVER names no file, as the launcher refuses it", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER }));

    const result = await runWith(environment, { ANTHILL_MCP_SERVER: "/nowhere/server.js" }, "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, server: "/nowhere/server.js" });
  });

  it.each([
    [{ server: "" }, "names no \"server\""],
    [{}, "names no \"server\""],
    [{ server: "apps/mcp/dist/server.js" }, "relative path"],
    [{ server: "/nowhere/server.js" }, "no file there"],
  ])("does not claim %j works", async (file, why) => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify(file));

    const result = await run(environment);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot serve any Anthill");
    expect(result.stderr).toContain(why);
  });

  it.each([
    [{ server: "apps/mcp/dist/server.js", note: "mine" }, "relative path"],
    [{ server: "/nowhere/server.js", note: "mine" }, "no file there"],
  ])("refuses to switch %j, and leaves the file as it was", async (file, why) => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify(file));

    const result = await run(environment, "web", "--no-build");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not switched");
    expect(result.stderr).toContain(why);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual(file);
  });

  it("fills an empty server with this checkout's, since the launcher reads it as none", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: " ", note: "mine" }));

    expect((await run(environment, "electron-dev", "--no-build")).code).toBe(0);

    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ server: SERVER, note: "mine", target: "electron-dev" });
  });

  it("warns about a target the server does not know, which it ignores", async () => {
    const { environment, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER, target: "staging" }));

    const said = await status(environment);

    expect(said).toMatchObject({ setting: null, ...serverSays(environment) });
    expect((said.warnings as string[]).join(" ")).toContain("staging");
  });
});

/*
  A server built before the targets — any build of 0.8.5 or earlier — has no
  target.js to ask. It still works: it serves the installed app and ignores
  "target", and the status says exactly that.
*/
describe("a server built before the targets", () => {
  async function legacy(root: string): Promise<string> {
    const checkout = join(root, "old-checkout");
    await mkdir(join(checkout, "apps", "mcp", "dist"), { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "anthill" }));
    const server = join(checkout, "apps", "mcp", "dist", "server.js");
    await writeFile(server, "");
    return server;
  }

  it("is reported as serving the installed app, with a warning to rebuild", async () => {
    const { environment, home: root, settings } = await home();
    const server = await legacy(root);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server, target: "web" }));

    const said = await status(environment);

    expect(said).toMatchObject({ ok: true, server, target: "app", label: "Anthill (installed app)" });
    expect((said.warnings as string[]).join(" ")).toContain('ignores "target"');
  });

  it("can still be reset with app, which succeeds", async () => {
    const { environment, home: root, settings } = await home();
    const server = await legacy(root);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server, target: "web" }));

    const result = await run(environment, "app");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Anthill (installed app)");
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ server });
  });

  it("is not switched to a target it would ignore", async () => {
    const { environment, home: root, settings } = await home();
    const server = await legacy(root);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server }));

    const result = await run(environment, "web", "--no-build");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not switched");
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ server });
  });
});

describe("what plugin:target builds", () => {
  /** An npm that writes down what it was asked to do, and where. */
  async function fakeNpm(root: string): Promise<{ npm: string; calls: () => Promise<{ cwd: string; args: string[] }[]> }> {
    const log = join(root, "npm.log");
    const npm = join(root, "npm-cli.mjs");
    await writeFile(npm, [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");`,
      'console.log("building…");',
    ].join("\n"));
    return {
      npm,
      calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    };
  }

  it.each([
    ["app", []],
    ["electron-dev", [["run", "build:deps"], ["run", "build", "--workspace=@anthill/mcp"]]],
    ["web", [["run", "build:deps"], ["run", "build", "--workspace=@anthill/mcp"], ["run", "build", "--workspace=@anthill/cli"]]],
  ])("%s runs %j in the checkout, keeping --json's output to the status", async (target, steps) => {
    const { environment, home: root, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER }));
    const npm = await fakeNpm(root);

    const result = await runWith(environment, { npm_execpath: npm.npm }, target, "--json");

    expect(result.code).toBe(0);
    expect(await npm.calls()).toEqual(steps.map((args) => ({ cwd: ROOT, args })));
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    if (steps.length > 0) expect(result.stderr).toContain("building…");
  });

  it("builds nothing for a relative server, which the launcher would refuse anyway", async () => {
    const { environment, home: root, settings } = await home();
    await mkdir(join(root, "rel", "apps", "mcp", "dist"), { recursive: true });
    await writeFile(join(root, "rel", "package.json"), JSON.stringify({ name: "anthill" }));
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: "rel/apps/mcp/dist/server.js" }));
    const npm = await fakeNpm(root);

    const result = await runWith(environment, { npm_execpath: npm.npm }, "electron-dev");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("relative path");
    expect(await npm.calls()).toEqual([]);
  });

  it("builds nothing with --no-build", async () => {
    const { environment, home: root, settings } = await home();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ server: SERVER }));
    const npm = await fakeNpm(root);

    expect((await runWith(environment, { npm_execpath: npm.npm }, "web", "--no-build")).code).toBe(0);

    expect(await npm.calls()).toEqual([]);
  });
});
