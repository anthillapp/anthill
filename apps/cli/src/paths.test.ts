/**
 * The CLI's path resolution: `--data-dir` wins over the default
 * `~/.anthill/cli` and is resolved to an absolute path; `ensureDataDir`
 * creates the directory idempotently.
 */

import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureDataDir, resolvePaths } from "./paths.js";

describe("resolvePaths", () => {
  it("defaults to ~/.anthill/cli under the user's home", async () => {
    const paths = await resolvePaths();
    expect(paths.home).toBe(homedir());
    expect(paths.userData).toBe(join(homedir(), ".anthill/cli"));
  });

  it("lets --data-dir win and resolves it to an absolute path", async () => {
    const dir = await mkdtemp(join(homedir(), "anthill-paths-"));
    try {
      const paths = await resolvePaths({ dataDir: dir });
      expect(paths.userData).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureDataDir", () => {
  it("creates the data directory (idempotent)", async () => {
    const dir = await mkdtemp(join(homedir(), "anthill-ensure-"));
    try {
      const target = join(dir, "nested", "data");
      await ensureDataDir({ userData: target, home: dir });
      await ensureDataDir({ userData: target, home: dir });
      await access(target);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
