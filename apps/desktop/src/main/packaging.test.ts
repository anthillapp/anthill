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

describe("what a release produces", () => {
  /* A `dir` target builds a bundle nobody can download. The published artefact
     is a disk image, and that is a fact about the release rather than a
     preference about the build. */
  it("builds a disk image, not a bare directory", () => {
    expect(manifest.build.mac.target.map((entry) => entry.target)).toContain("dmg");
  });
});
