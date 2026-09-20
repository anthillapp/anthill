import { copyFile, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAllOrNothing } from "./safe-write.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), copyFile: vi.fn(actual.copyFile) };
});

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(copyFile).mockReset().mockImplementation(actual.copyFile);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anthill-export-failure-"));
  roots.push(root);
  const original = Buffer.from([0, 255, 128, 10]);
  await writeFile(join(root, "old.md"), original, { mode: 0o640 });
  const files = ["old.md", "new.md"].map((name) => ({ path: join(root, name), relative: name, content: "replacement" }));
  return { root, original, files };
}

describe("export I/O failures", () => {
  it("leaves original bytes intact when a staging write partially succeeds then fails", async () => {
    const { root, original, files } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      await actual.writeFile(path, "partial");
      throw new Error("ENOSPC");
    });
    expect(await writeAllOrNothing(files)).toMatchObject({ ok: false, rolledBack: true });
    expect(await readFile(files[0].path)).toEqual(original);
    expect(await readdir(root)).toEqual(["old.md"]);
  });

  it("does not mistake a failed backup read for an absent original", async () => {
    const { original, files } = await fixture();
    vi.mocked(copyFile).mockRejectedValueOnce(new Error("EACCES"));
    expect(await writeAllOrNothing(files)).toMatchObject({ ok: false, rolledBack: true });
    expect(await readFile(files[0].path)).toEqual(original);
  });

  it("restores bytes and permissions after a later commit fails", async () => {
    const { root, original, files } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(actual.rename).mockRejectedValueOnce(new Error("commit failed"));
    expect(await writeAllOrNothing(files)).toMatchObject({ ok: false, rolledBack: true });
    expect(await readFile(files[0].path)).toEqual(original);
    expect((await lstat(files[0].path)).mode & 0o777).toBe(0o640);
    expect(await readdir(root)).toEqual(["old.md"]);
  });

  it("keeps a recovery copy and reports its path when rollback also fails", async () => {
    const { original, files } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(actual.rename)
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockRejectedValueOnce(new Error("restore failed"));
    const result = await writeAllOrNothing(files);
    expect(result).toMatchObject({ ok: false, rolledBack: false });
    if (result.ok) throw new Error("expected failure");
    const backup = result.error.split("recovery required: ")[1];
    expect(await readFile(backup)).toEqual(original);
  });
});
