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

import { destinationInside, FolderGrants, rootToWrite, writeAllOrNothing, type StagedFile } from "./safe-write.js";

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

  it("does not create directories outside the grant before refusing a linked ancestor", async () => {
    const { root, outside } = await sandbox();
    await symlink(outside, join(root, "agents"), "dir");
    expect((await destinationInside(root, "agents/new/nested/dev.md")).ok).toBe(false);
    await expect(lstat(join(outside, "new"))).rejects.toMatchObject({ code: "ENOENT" });
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

/*
  ANT-200. A workflow remembers its run folder, and a restart forgets every
  grant: re-running a saved workflow after relaunching Anthill refused its own
  folder, and no agent files were written.
*/
describe("a run folder remembered from an earlier session", () => {
  it("is written to as it is when this session granted it", async () => {
    const { root } = await sandbox();
    const grants = new FolderGrants();
    await grants.grant(root);
    let asked = false;
    const decided = await rootToWrite(root, grants, async () => {
      asked = true;
      return undefined;
    });
    expect(decided).toEqual({ root: await realpath(root) });
    expect(asked).toBe(false);
  });

  it("is confirmed in a dialog pointing at it, and the confirmation grants it", async () => {
    const { root } = await sandbox();
    const grants = new FolderGrants();
    let pointedAt: string | undefined;
    const decided = await rootToWrite(root, grants, async (defaultPath) => {
      pointedAt = defaultPath;
      return defaultPath;
    });
    expect(pointedAt).toBe(root);
    expect(decided).toEqual({ root: await realpath(root) });
    expect(await grants.resolveGranted(root)).toBeTruthy();
  });

  it("goes where the dialog says when the author picks another folder", async () => {
    const { root, outside } = await sandbox();
    const grants = new FolderGrants();
    const decided = await rootToWrite(root, grants, async () => outside);
    expect(decided).toEqual({ root: await realpath(outside) });
    // The remembered one was never confirmed, so it is still not granted.
    expect(await grants.resolveGranted(root)).toBeUndefined();
  });

  it("writes nowhere when the confirmation is closed", async () => {
    const { root } = await sandbox();
    const grants = new FolderGrants();
    expect(await rootToWrite(root, grants, async () => undefined)).toEqual({ cancelled: true });
    expect(await grants.resolveGranted(root)).toBeUndefined();
  });
});

/**
 * A failed export leaves the folder as it was found (ANT-100).
 *
 * Files were written one at a time straight into the chosen folder. A failure
 * part way through left the repository holding some of the new agent files
 * beside some of the old ones — matching no version of the workflow, and
 * matching the prompt the user had just copied least of all.
 */
describe("exporting all of the files or none of them", () => {
  async function staged(root: string, names: string[]): Promise<StagedFile[]> {
    return names.map((name) => ({
      path: join(root, name),
      content: `new ${name}\n`,
      relative: name,
    }));
  }

  it("writes every file when nothing goes wrong", async () => {
    const { root } = await sandbox();
    const result = await writeAllOrNothing(await staged(root, ["a.md", "b.md"]));
    expect(result).toMatchObject({ ok: true, written: ["a.md", "b.md"] });
    expect(await readFile(join(root, "b.md"), "utf8")).toBe("new b.md\n");
  });

  /**
   * The failure is injected at each position in turn, because "the first one
   * worked" and "the last one worked" fail differently: one has files to put
   * back, the other has files to remove.
   */
  it("restores what it overwrote, wherever the failure lands", async () => {
    for (const failAt of [0, 1, 2]) {
      const { root } = await sandbox();
      await writeFile(join(root, "a.md"), "old a\n");
      await writeFile(join(root, "b.md"), "old b\n");
      await writeFile(join(root, "c.md"), "old c\n");

      const files = await staged(root, ["a.md", "b.md", "c.md"]);
      // A directory cannot be opened for writing, which is a write failure
      // with none of the noise of permissions on different platforms.
      await rm(join(root, files[failAt].relative));
      await mkdir(files[failAt].path);

      const result = await writeAllOrNothing(files);

      expect(result.ok, `failAt ${failAt}`).toBe(false);
      if (!result.ok) expect(result.rolledBack).toBe(true);
      // Every file that had contents has them back.
      for (const name of ["a.md", "b.md", "c.md"]) {
        if (name === files[failAt].relative) continue;
        expect(await readFile(join(root, name), "utf8"), `${name} after failAt ${failAt}`)
          .toBe(`old ${name.slice(0, 1)}\n`);
      }
    }
  });

  it("removes a file it created, rather than leaving a new one behind", async () => {
    const { root } = await sandbox();
    const files = await staged(root, ["created.md", "blocked.md"]);
    await mkdir(files[1].path);

    const result = await writeAllOrNothing(files);

    expect(result.ok).toBe(false);
    // It did not exist before, so putting the folder back means deleting it.
    await expect(readFile(join(root, "created.md"), "utf8")).rejects.toThrow();
  });

  it("does not report rollback failure when preflight rejected a directory", async () => {
    const { root } = await sandbox();
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "a.md"), "old a\n");
    const files: StagedFile[] = [
      { path: join(nested, "a.md"), content: "new a\n", relative: "nested/a.md" },
      { path: join(nested, "b.md"), content: "new b\n", relative: "nested/b.md" },
    ];

    // The directory is rejected before any destination is replaced.
    await mkdir(files[1].path);
    const result = await writeAllOrNothing([
      files[0],
      { ...files[1], content: "x" },
      { path: join(nested, "c.md"), content: "y", relative: "nested/c.md" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rolledBack).toBe(true);
    expect(await readFile(files[0].path, "utf8")).toBe("old a\n");
  });
});
