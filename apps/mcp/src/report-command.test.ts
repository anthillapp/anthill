/**
 * ANT-232. Which command the harness is told to report progress with.
 *
 * The PATH and the files on it are injected, so the answer is worked out for
 * each case without depending on what this machine has installed.
 */

import { describe, expect, it } from "vitest";

import { onPath, reportingInvocation, type InvocationDeps } from "./report-command.js";
import type { ResolvedTarget } from "./target.js";
import { webShellCli } from "./web-launcher.js";

const HOME = "/home/someone";
const NODE = "/usr/local/bin/node";

function machine(files: string[], over: Partial<InvocationDeps> = {}): InvocationDeps {
  return {
    platform: "linux",
    home: HOME,
    env: { PATH: "/usr/bin:/home/someone/.npm/bin" },
    executable: (path) => files.includes(path),
    node: NODE,
    ...over,
  };
}

const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  target: "web",
  source: "platform",
  label: "Anthill (web)",
  dataDir: `${HOME}/.anthill/cli`,
  checkout: "/src/anthill",
  ...over,
});

describe("the reporting command", () => {
  it.each(["app", "electron-dev"] as const)("is plain anthill for %s", (id) => {
    expect(reportingInvocation(target({ target: id }), machine([]))).toEqual({});
  });

  it("is plain anthill for the web shell when anthill is on the harness PATH", () => {
    expect(reportingInvocation(target(), machine(["/home/someone/.npm/bin/anthill"]))).toEqual({});
  });

  it("is this node on the checkout's CLI when anthill is not on the PATH", () => {
    expect(reportingInvocation(target(), machine([]))).toEqual({ command: `${NODE} ${webShellCli("/src/anthill")}` });
  });

  it("quotes a checkout path, and a node path, with spaces in them", () => {
    const invocation = reportingInvocation(
      target({ checkout: "/Users/some one/anthill" }),
      machine([], { node: "/Applications/My Node/bin/node" }),
    );
    expect(invocation.command).toBe(`'/Applications/My Node/bin/node' '${webShellCli("/Users/some one/anthill")}'`);
  });

  it("names the data directory only when the web shell's is not the default", () => {
    expect(reportingInvocation(target({ dataDir: "/srv/anthill" }), machine(["/usr/bin/anthill"])))
      .toEqual({ dataDir: "/srv/anthill", platform: "linux" });
  });

  it("on Windows, leads with node from the PATH and forward-slashed, quoted paths, so every shell reads it", () => {
    const deps = machine(["C:/Program Files/nodejs/node.EXE"], {
      platform: "win32",
      env: { Path: "C:\\Program Files\\nodejs", PATHEXT: ".EXE" },
      executable: (path) => path.replace(/\\/g, "/") === "C:/Program Files/nodejs/node.EXE",
      node: "C:\\Program Files\\nodejs\\node.exe",
    });
    const invocation = reportingInvocation(target({ checkout: "C:\\dev\\anthill", dataDir: "D:\\data" }), deps);
    expect(invocation.command).toBe(`node "${webShellCli("C:\\dev\\anthill").replace(/\\/g, "/")}"`);
    expect(invocation).toMatchObject({ platform: "win32" });
  });

  it("on Windows without node on the PATH, falls back to this node, quoted", () => {
    const deps = machine([], { platform: "win32", env: { Path: "C:\\Windows" }, node: "C:\\Program Files\\nodejs\\node.exe" });
    expect(reportingInvocation(target(), deps).command).toMatch(/^"C:\/Program Files\/nodejs\/node\.exe" "/);
  });

  it("keeps the data directory with the node fallback", () => {
    expect(reportingInvocation(target({ dataDir: "/srv/anthill" }), machine([])))
      .toEqual({ command: `${NODE} ${webShellCli("/src/anthill")}`, dataDir: "/srv/anthill", platform: "linux" });
  });

  it("falls back to anthill without a checkout, which is all there is to offer", () => {
    expect(reportingInvocation(target({ checkout: undefined }), machine([]))).toEqual({});
  });
});

describe("looking anthill up on the PATH", () => {
  it("finds it in any PATH directory, and nothing that is not there", () => {
    expect(onPath("anthill", machine(["/home/someone/.npm/bin/anthill"]))).toBe("/home/someone/.npm/bin/anthill");
    expect(onPath("anthill", machine(["/opt/anthill"]))).toBeUndefined();
    expect(onPath("anthill", machine(["/usr/bin/anthill"], { env: {} }))).toBeUndefined();
  });

  it("uses Path, ; and PATHEXT in order on Windows, and not the extensionless npm shim", () => {
    const seen: string[] = [];
    const deps = machine([], {
      platform: "win32",
      env: { Path: "C:\\Windows;;C:\\npm", PATHEXT: ".EXE;.CMD" },
      executable: (path) => { seen.push(path); return path.replace(/\\/g, "/") === "C:/npm/anthill.CMD"; },
    });
    expect(onPath("anthill", deps)?.replace(/\\/g, "/")).toBe("C:/npm/anthill.CMD");
    expect(seen.map((path) => path.replace(/\\/g, "/"))).toEqual([
      "C:/Windows/anthill.EXE", "C:/Windows/anthill.CMD", "C:/npm/anthill.EXE", "C:/npm/anthill.CMD",
    ]);
  });
});
