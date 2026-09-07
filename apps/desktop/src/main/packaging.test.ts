/**
 * That the packaged app can find what packaging put where.
 *
 * This exists because of a bug the development build could not have caught. The
 * Electron-ABI copy of better-sqlite3 is taken out of the asar by `asarUnpack`,
 * which leaves it at `app.asar.unpacked/native/`, and the lookup went to
 * `Resources/native/` — where a file would be only if it were an
 * `extraResource`. Finding nothing, it returned `undefined`, better-sqlite3 fell
 * back to its own resolution, and it picked up the *Node*-ABI copy that ships
 * alongside as an ordinary dependency. The app died at startup on a
 * NODE_MODULE_VERSION mismatch — the exact failure the lookup exists to prevent,
 * in the one build nobody runs while developing.
 *
 * So the packaging config and the code that reads it are checked against each
 * other, as data. Neither can be edited into disagreement without this failing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
  build: {
    files: string[];
    asarUnpack: string[];
    mac: { target: { target: string; arch: string[] }[] };
  };
};
const main = readFileSync(resolve("src/main/index.ts"), "utf8");

describe("the native binding survives packaging", () => {
  it("ships the Electron-ABI binary", () => {
    expect(manifest.build.files).toContain("native/**/*");
  });

  it("unpacks native addons, which is what decides where they land", () => {
    expect(manifest.build.asarUnpack.some((glob) => glob.endsWith(".node"))).toBe(true);
  });

  /*
   * The two facts above put the file at `app.asar.unpacked/native/`, so the
   * lookup has to name that path. This is the assertion that would have failed.
   */
  it("looks where unpacking actually leaves it", () => {
    expect(main).toContain("app.asar.unpacked/native/better_sqlite3.node");
  });

  /* Kept as a second candidate so an `extraResources` layout still works. */
  it("still tries the extraResources location as well", () => {
    expect(main).toContain('join(process.resourcesPath, "native/better_sqlite3.node")');
  });
});

/**
 * The version people read and the version things are named after.
 *
 * These were two numbers: the launch screen carried `Version 0.4` as a literal
 * while this manifest said `0.0.1`, and the disk image was named after the
 * manifest. A number maintained in two places disagrees with itself eventually,
 * and the copy on screen is the one that goes stale — it is the one nothing
 * else depends on.
 */
describe("the version is one number", () => {
  it("is not written into the launch screen by hand", () => {
    const launch = readFileSync(resolve("src/renderer/LaunchWindow.tsx"), "utf8");
    expect(launch).toContain("__ANTHILL_VERSION__");
    expect(launch).not.toMatch(/Version \d+\.\d+/);
  });

  it("reaches the screen as the manifest's own value", () => {
    // The build and the tests inject the same constant, so this is what ships.
    expect(__ANTHILL_VERSION__).toBe(manifest.version);
  });

  it("is a release version rather than the scaffold's placeholder", () => {
    expect(manifest.version).not.toBe("0.0.1");
  });
});

describe("what a release produces", () => {
  /* A `dir` target builds a bundle nobody can download. The published artefact
     is a disk image, and that is a fact about the release rather than a
     preference about the build. */
  it("builds a disk image, not a bare directory", () => {
    expect(manifest.build.mac.target.map((entry) => entry.target)).toContain("dmg");
  });
});

/**
 * What notarisation requires, checked against the manifest rather than trusted.
 *
 * Apple will not notarise a build without the hardened runtime, and the
 * hardened runtime stops Electron running unless it is told otherwise: V8
 * compiles and executes machine code at runtime, the launcher sets DYLD_*, and
 * better-sqlite3 is a native module signed separately from the framework.
 * Getting any of that wrong produces a build that passes every test here and
 * dies on the first launch of the one copy nobody ran before publishing it.
 */
describe("signing and notarisation", () => {
  const mac = manifest.build.mac as Record<string, unknown>;

  it("asks for the hardened runtime notarisation requires", () => {
    expect(mac.hardenedRuntime).toBe(true);
  });

  it("does not force an ad-hoc signature over a real certificate", () => {
    // `identity: null` meant "never sign", which no amount of certificate
    // could override.
    expect("identity" in mac).toBe(false);
  });

  it("points at entitlements for the app and for its helpers", () => {
    expect(mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(mac.entitlementsInherit).toBe("build/entitlements.mac.plist");
  });

  it("grants exactly what Electron needs under the hardened runtime", () => {
    const plist = readFileSync(resolve("build/entitlements.mac.plist"), "utf8");
    for (const needed of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(plist).toContain(needed);
    }
  });

  /** A hole in a default-deny policy is worth noticing when it appears. */
  it("grants nothing beyond those four", () => {
    const plist = readFileSync(resolve("build/entitlements.mac.plist"), "utf8");
    const granted = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(granted).toHaveLength(4);
  });
});
