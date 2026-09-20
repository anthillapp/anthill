import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeSession } from "./claude-session.js";

const HOST = "11111111-1111-4111-8111-111111111111";
const CLI = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(metadata: unknown = { sessionId: `local_${HOST}`, cliSessionId: CLI }) {
  const root = await mkdtemp(join(tmpdir(), "anthill-session-resolution-"));
  roots.push(root);
  const dir = join(root, "account", "organization");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `local_${HOST}.json`);
  await writeFile(path, JSON.stringify(metadata));
  return { root, path };
}

describe("Claude desktop session identity", () => {
  it("resolves the exact host id with or without the local prefix", async () => {
    const { root } = await fixture();
    expect(await resolveClaudeSession(root, HOST)).toBe(CLI);
    expect(await resolveClaudeSession(root, `local_${HOST}`)).toBe(CLI);
    expect(await resolveClaudeSession(root, CLI)).toBeUndefined();
  });
  it.each([
    null, {}, { sessionId: `local_${HOST}`, cwd: "/same-project" },
    { sessionId: "another-session", cliSessionId: CLI },
    { sessionId: `local_${HOST}`, cliSessionId: "../../secret" },
  ])("does not infer identity from incomplete or mismatched metadata: %j", async (metadata) => {
    const { root } = await fixture(metadata);
    expect(await resolveClaudeSession(root, HOST)).toBeUndefined();
  });
  it("tolerates missing files, partial writes and unsafe input", async () => {
    const { root, path } = await fixture();
    await writeFile(path, "{");
    expect(await resolveClaudeSession(root, HOST)).toBeUndefined();
    expect(await resolveClaudeSession(root, "../../outside")).toBeUndefined();
    expect(await resolveClaudeSession(join(root, "missing"), HOST)).toBeUndefined();
  });
  it("refuses conflicting mappings across accounts", async () => {
    const { root } = await fixture();
    const dir = join(root, "second-account", "organization");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `local_${HOST}.json`), JSON.stringify({ sessionId: `local_${HOST}`, cliSessionId: "33333333-3333-4333-8333-333333333333" }));
    expect(await resolveClaudeSession(root, HOST)).toBeUndefined();
  });
  it("does not follow metadata symlinks", async () => {
    const { root, path } = await fixture();
    const target = join(root, "elsewhere.json");
    await writeFile(target, JSON.stringify({ sessionId: `local_${HOST}`, cliSessionId: CLI }));
    await rm(path);
    await symlink(target, path);
    expect(await resolveClaudeSession(root, HOST)).toBeUndefined();
  });
});
