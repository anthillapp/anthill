/**
 * Which models Codex offers, read from Codex's own catalogue.
 *
 * The alternative was a list of somebody else's model names hand-kept in
 * Anthill's source. That list is stale on their release schedule rather than
 * ours, and being stale is not a cosmetic problem here: a name Anthill offers
 * that Codex has retired produces an agent file that fails at the far end, and
 * a name Codex has added is one the author simply cannot pick.
 *
 * Codex will say. `codex debug models` prints its own catalogue as JSON — a
 * command it documents in its own `--help`, not one invented here — and Codex
 * keeps the same JSON in `~/.codex/models_cache.json`, which is read when the
 * command cannot run. Both are local and read-only: nothing starts a session,
 * nothing touches the project, and no account is contacted by Anthill.
 *
 * `debug` is not a stability promise, which is exactly why the file is kept as
 * a second source rather than dropped: if the command goes away, the screen
 * degrades to a slightly older list instead of to nothing.
 *
 * What this can and cannot claim is the important part. Both sources record
 * what Codex offers *this machine*, so they are better evidence than "supported
 * by this version" — but neither is a check of what the account may run right
 * now, and nothing here says otherwise. The screen says where the list came
 * from and, for the cache, when Codex last looked.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runProcess, type SpawnFn } from "@anthill/runtimes";

import type { CodexModelOption } from "../shared/ipc.js";

/** What the catalogue is, before the capability question is answered. */
export type CodexModelList = { models: CodexModelOption[]; fetchedAt?: string };

/** Where Codex keeps it. Overridable so tests never read the real one. */
export function codexCachePath(home = homedir()): string {
  return join(home, ".codex", "models_cache.json");
}

type CachedModel = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
};

function readEfforts(value: unknown): CodexModelOption["efforts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const bag = item as { effort?: unknown; description?: unknown };
    if (typeof bag.effort !== "string" || !bag.effort.trim()) return [];
    return [
      {
        id: bag.effort,
        ...(typeof bag.description === "string" && bag.description.trim()
          ? { hint: bag.description }
          : {}),
      },
    ];
  });
}

function readModel(value: unknown): CodexModelOption | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as CachedModel;
  if (typeof item.slug !== "string" || !item.slug.trim()) return undefined;
  // Codex hides some entries from its own picker — internal or retired ones.
  // Offering them would be Anthill showing what the tool itself will not.
  if (item.visibility !== "list") return undefined;

  return {
    id: item.slug,
    label: typeof item.display_name === "string" && item.display_name ? item.display_name : item.slug,
    ...(typeof item.description === "string" && item.description.trim()
      ? { hint: item.description }
      : {}),
    efforts: readEfforts(item.supported_reasoning_levels),
    ...(typeof item.default_reasoning_level === "string" && item.default_reasoning_level
      ? { defaultEffort: item.default_reasoning_level }
      : {}),
  };
}

/**
 * The catalogue, from whichever local source can answer.
 *
 * Asked of Codex first, because that answer is current by construction. The
 * cache is the fallback rather than the primary: it is the same JSON, only as
 * fresh as the last time Codex fetched it.
 *
 * Nothing rather than an empty list when neither can answer. The two say
 * different things — an empty list would claim Codex offers no models, and the
 * honest answer when nobody has told Anthill is that nobody has told it.
 */
export async function readCodexModels(options: {
  spawnFn?: SpawnFn;
  cachePath?: string;
} = {}): Promise<CodexModelList | undefined> {
  const asked = await askCodex(options.spawnFn);
  if (asked) return asked;
  return readCachedCodexModels(options.cachePath ?? codexCachePath());
}

/**
 * `codex debug models`, which prints the catalogue and exits.
 *
 * Read-only and short: it starts no session, reads nothing from the project,
 * and is given a few seconds before being given up on — a model list is not
 * worth making the editor wait.
 */
async function askCodex(spawnFn?: SpawnFn): Promise<CodexModelList | undefined> {
  const outcome = await runProcess({
    command: "codex",
    args: ["debug", "models"],
    timeoutMs: 5_000,
    ...(spawnFn ? { spawnFn } : {}),
  }).catch(() => undefined);
  if (!outcome || outcome.spawnError || outcome.exitCode !== 0) return undefined;
  return parseCatalog(outcome.stdout);
}

export async function readCachedCodexModels(
  path = codexCachePath(),
): Promise<CodexModelList | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return parseCatalog(text);
}

function parseCatalog(text: string): CodexModelList | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const bag = parsed as { models?: unknown; fetched_at?: unknown };
  if (!Array.isArray(bag.models)) return undefined;

  const models = bag.models
    .map(readModel)
    .filter((item): item is CodexModelOption => item !== undefined)
    // Codex's own ordering, so the list reads the way it does in Codex rather
    // than in whatever order the file happens to be written.
    .sort((a, b) => priorityOf(bag.models as CachedModel[], a) - priorityOf(bag.models as CachedModel[], b));

  if (models.length === 0) return undefined;
  return {
    models,
    ...(typeof bag.fetched_at === "string" ? { fetchedAt: bag.fetched_at } : {}),
  };
}

function priorityOf(raw: CachedModel[], option: CodexModelOption): number {
  const found = raw.find((item) => item.slug === option.id);
  return typeof found?.priority === "number" ? found.priority : Number.MAX_SAFE_INTEGER;
}
