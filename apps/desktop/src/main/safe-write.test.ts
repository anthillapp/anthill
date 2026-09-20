/**
 * Export writes inside the folder the user chose, and nowhere else (ANT-96).
 *
 * The check used to be lexical, so a symlinked directory inside the chosen
 * folder satisfied it while the write landed somewhere else. These are the
 * shapes that got through.
 */

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { destinationInside, FolderGrants } from "./safe-write.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "anthill-export-"));
  roots.push(base);
  const root = join(base, "chosen");
  const outside = join(base, "elsewhere");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, outside };
}

describe("choosing where a generated file goes", () => {
  it("allows an ordinary path inside the folder", async () => {
    const { root } = await sandbox();
    const result = await destinationInside(root, "agents/dev.md");
    expect(result.ok).toBe(true);
    // Compared against the real root: on macOS the temp directory is reached
    // through a link, and what comes back is where the bytes actually go.
    if (result.ok) expect(result.path).toBe(join(await realpath(root), "agents", "dev.md"));
  });

  it("refuses a path that climbs out lexically", async () => {
    const { root } = await sandbox();
    for (const relative of ["../escaped.md", "../../escaped.md", "agents/../../escaped.md"]) {
      const result = await destinationInside(root, relative);
      expect(result.ok, relative).toBe(false);
    }
  });

  /**
   * The one the lexical check could not see. `<root>/agents` is a link to a
   * directory outside, so `<root>/agents/dev.md` starts with the root and
   * lands elsewhere.
   */
  it("refuses a path through a symlinked directory", async () => {
    const { root, outside } = await sandbox();
    await symlink(outside, join(root, "agents"), "dir");

    const result = await destinationInside(root, "agents/dev.md");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resolves outside");
  });

  it("refuses to write through a link left at the destination itself", async () => {
    const { root, outside } = await sandbox();
    const target = join(outside, "target.md");
    await writeFile(target, "someone else's file\n");
    await symlink(target, join(root, "dev.md"));

    const result = await destinationInside(root, "dev.md");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("link");
    // And the thing it pointed at is untouched.
    expect(await readFile(target, "utf8")).toBe("someone else's file\n");
  });

  it("creates the parent directory it is going to write into", async () => {
    const { root } = await sandbox();
    const result = await destinationInside(root, "deeply/nested/dev.md");
    expect(result.ok).toBe(true);
    expect((await lstat(join(root, "deeply", "nested"))).isDirectory()).toBe(true);
  });
});

/**
 * A root that arrives from the renderer is only as good as the dialog it came
 * from, and main is the only side that can say.
 */
describe("the folders a dialog handed out", () => {
  it("accepts a root it granted, and refuses one it did not", async () => {
    const { root, outside } = await sandbox();
    const grants = new FolderGrants();

    const granted = await grants.grant(root);

    expect(await grants.resolveGranted(root)).toBe(granted);
    expect(await grants.resolveGranted(outside)).toBeUndefined();
  });

  it("refuses a different spelling of an ungranted folder", async () => {
    const { root, outside } = await sandbox();
    const grants = new FolderGrants();
    await grants.grant(root);

    // A link pointing at the granted folder is not the granted folder: it
    // resolves elsewhere, and the grant is about where bytes land.
    await symlink(outside, join(root, "link"), "dir");

    expect(await grants.resolveGranted(join(root, "link"))).toBeUndefined();
  });

  it("recognises a granted folder reached by a different path", async () => {
    const { root } = await sandbox();
    const grants = new FolderGrants();
    await grants.grant(root);

    // The same real directory, spelled with a redundant hop. Refusing this
    // would make the grant depend on how the renderer echoed the string back.
    expect(await grants.resolveGranted(join(root, ".", ""))).toBeTruthy();
  });

  it("refuses everything before anything is granted", async () => {
    const { root } = await sandbox();
    expect(await new FolderGrants().resolveGranted(root)).toBeUndefined();
  });
});
