import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withWorkflowLock } from "./lock.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anthill-lease-"));
  roots.push(root);
  return join(root, "identity.json");
}

describe("workflow transaction lease", () => {
  it("releases ownership after a failed mutation", async () => {
    const identity = await path();
    await expect(withWorkflowLock(identity, async () => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    await expect(withWorkflowLock(identity, async () => "next writer")).resolves.toBe("next writer");
  });

  it("recovers an abandoned lease only after its heartbeat is stale", async () => {
    const identity = await path();
    await mkdir(`${identity}.lock`);
    const stale = new Date(Date.now() - 120_000);
    await utimes(`${identity}.lock`, stale, stale);
    await expect(withWorkflowLock(identity, async () => "recovered")).resolves.toBe("recovered");
  });
});
