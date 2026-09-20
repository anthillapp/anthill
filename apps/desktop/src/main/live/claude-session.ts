/** Resolve a Claude desktop conversation to its CLI transcript, never by cwd or time. */
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeDesktopSessionsRoot(): string | undefined {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")
    : undefined;
}

async function directories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

/**
 * Claude stores <account>/<organization>/local_<id>.json with both sessionId
 * and cliSessionId. Older handovers sometimes submitted that host id without
 * its local_ prefix. Only that explicit relationship can repair the binding;
 * a similar title, matching directory or recent transcript cannot.
 */
export async function resolveClaudeSession(root: string, reportedId: string): Promise<string | undefined> {
  const id = reportedId.replace(/^local_/, "");
  if (!UUID.test(id)) return undefined;
  const hostId = `local_${id}`;
  const matches = new Set<string>();
  for (const account of await directories(root)) {
    for (const organization of await directories(account)) {
      const path = join(organization, `${hostId}.json`);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.size > 1024 * 1024) continue;
      try {
        const metadata: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!metadata || typeof metadata !== "object") continue;
        const record = metadata as Record<string, unknown>;
        if (record.sessionId !== hostId || typeof record.cliSessionId !== "string" || !UUID.test(record.cliSessionId)) continue;
        matches.add(record.cliSessionId);
      } catch {
        // Partial writes and unreadable metadata are not correlation evidence.
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
