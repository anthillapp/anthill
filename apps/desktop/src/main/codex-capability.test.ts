/**
 * Whether the installed `codex` reads project-scoped custom agents.
 *
 * The question exists because the alternative misleads: Anthill would offer a
 * per-agent model, write the file, and a session would quietly run every step
 * on whatever model it started with. A picker whose answer is silently
 * discarded is worse than no picker.
 *
 * The rule these tests hold: `unknown` never becomes `unsupported`. Telling
 * somebody to update software that is already fine is the one wrong direction.
 */

import { chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { codexExecutablePath, readCodexAgentSupport } from "./codex-capability.js";

async function fakeCodex(contents: Buffer | string, name = "codex"): Promise<string> {
  // Realpath'd, because macOS hands out /var paths that resolve to /private/var
  // and the function under test resolves them too.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "anthill-codex-bin-")));
  const path = join(dir, name);
  await writeFile(path, contents);
  await chmod(path, 0o755);
  return path;
}

describe("asking the binary about itself", () => {
  it("says supported when the path literal is in it", async () => {
    const path = await fakeCodex("...irrelevant bytes... .codex/agents ...more...");
    expect(await readCodexAgentSupport(path)).toBe("supported");
  });

  it("says unsupported when it is not", async () => {
    const path = await fakeCodex("...a build that predates custom agents...");
    expect(await readCodexAgentSupport(path)).toBe("unsupported");
  });

  /* The marker could fall across a read boundary, and a false "unsupported"
     would send somebody to update software that is already fine. */
  it("finds the marker even when it straddles a chunk boundary", async () => {
    const marker = ".codex/agents";
    // Well past the stream's chunk size, and split so no single chunk holds it.
    const filler = Buffer.alloc(200_000, 0x61);
    const path = await fakeCodex(Buffer.concat([filler, Buffer.from(marker), filler]));
    expect(await readCodexAgentSupport(path)).toBe("supported");
  });

  it("says unknown when there is no codex to ask", async () => {
    // Not "unsupported": the absence of the CLI is a fact about the machine,
    // and the connection card already says the tool is missing.
    expect(await readCodexAgentSupport(undefined, { PATH: join(tmpdir(), "nothing-here") })).toBe(
      "unknown",
    );
  });

  it("says unknown when the file cannot be read", async () => {
    expect(await readCodexAgentSupport(join(tmpdir(), "anthill-no-such-binary"))).toBe("unknown");
  });
});

describe("finding the codex the author actually runs", () => {
  it("takes the first executable on PATH, in PATH order", async () => {
    const first = await fakeCodex(".codex/agents");
    const second = await fakeCodex("older");
    const path = await codexExecutablePath({
      PATH: [first, second].map((item) => join(item, "..")).join(":"),
    });
    expect(path).toBe(first);
  });

  /*
   * The usual install is a link into a versioned release directory, so the
   * link itself contains nothing. And a newer copy inside some application
   * bundle says nothing about the command the author will actually run.
   */
  it("follows a symlink to the file it points at", async () => {
    const real = await fakeCodex(".codex/agents", "codex-0.153.3");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "anthill-codex-link-")));
    await symlink(real, join(dir, "codex"));

    expect(await codexExecutablePath({ PATH: dir })).toBe(real);
    expect(await readCodexAgentSupport(undefined, { PATH: dir })).toBe("supported");
  });
});
