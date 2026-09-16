/**
 * Which models pi offers, read from pi's own catalogue.
 *
 * The alternative was a list of somebody else's model names hand-kept in
 * Anthill's source, which is stale on their release schedule rather than
 * ours. pi will say: `pi --list-models` prints its catalogue as a table — a
 * command it documents in its own `--help`, not one invented here. That is
 * the only source: pi keeps no model cache file the way Codex does
 * (`~/.codex/models_cache.json`), so when the command cannot run the
 * catalogue is `undefined` rather than an empty list. "pi offers no models"
 * is not something a missing binary is evidence for.
 *
 * The table is not JSON:
 *
 *   provider   model                  context  max-out  thinking  images
 *   llama-cpp  qwen36-27b-q5-fullctx  114.7K   65K      yes       yes
 *
 * The `thinking` column says whether the model can run at a thinking level at
 * all. The levels themselves are fixed by `pi --thinking` (off, minimal, low,
 * medium, high, xhigh, max) and are not per-model, so a thinking-capable
 * model offers the whole fixed set and a non-thinking one offers none. The
 * "off" level is the same as leaving the level unset, which the UI already
 * has as "inherit", so it is not offered again.
 *
 * Everything here is local and read-only: the command starts no session,
 * reads nothing from the project, and no account is contacted by Anthill.
 */

import { runProcess, type SpawnFn } from "@anthill/runtimes";

import type { PiModelOption } from "../shared/ipc.js";

/** What the catalogue is. pi keeps no cache, so there is no `fetchedAt`. */
export type PiModelList = { models: PiModelOption[] };

/**
 * The thinking levels `pi --thinking` accepts, minus `off` (which is the same
 * as the UI's "inherit" — no level set).
 */
export const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The catalogue, asked of pi.
 *
 * `undefined` rather than an empty list when the command cannot run or lists
 * nothing: the two would say the same thing to the screen (no model to offer),
 * and the honest answer when pi could not be reached is that it was not
 * reached, not that it offers nothing.
 *
 * The answer is kept once per process. pi keeps no model cache file, so the
 * catalogue is asked for live — but asking on every LaunchWindow mount would
 * spawn `pi --list-models` (with its 5s timeout) on machines that may not
 * have pi. The first answer, a catalogue or `undefined`, is what later mounts
 * get; the command runs at most once per process. An injected `spawnFn` (the
 * test seam) bypasses the cache so a test can drive the spawn directly.
 */
let piModelsPromise: Promise<PiModelList | undefined> | undefined;

export async function readPiModels(options: { spawnFn?: SpawnFn } = {}): Promise<PiModelList | undefined> {
  if (options.spawnFn) return await askPiForModels(options.spawnFn);
  if (!piModelsPromise) piModelsPromise = askPiForModels();
  return piModelsPromise;
}

async function askPiForModels(spawnFn?: SpawnFn): Promise<PiModelList | undefined> {
  const outcome = await runProcess({
    command: "pi",
    args: ["--list-models"],
    timeoutMs: 5_000,
    ...(spawnFn ? { spawnFn } : {}),
  }).catch(() => undefined);
  if (!outcome || outcome.spawnError || outcome.exitCode !== 0) return undefined;
  return parsePiModels(outcome.stdout);
}

/**
 * Parse `pi --list-models` table output into model options.
 *
 * Tolerant of the exact column padding: each row is split on whitespace, the
 * first two fields are provider and model, and the `thinking` flag is read
 * from the second-to-last field so a model name with a space would not shift
 * it. The header row is skipped by its first two fields. `undefined` when
 * nothing parses — a table with no data rows is not a catalogue.
 */
export function parsePiModels(text: string): PiModelList | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const models: PiModelOption[] = [];
  for (const line of lines) {
    const cols = line.split(/\s+/);
    if (cols[0] === "provider" && cols[1] === "model") continue; // header row
    if (cols.length < 5) continue; // not a data row
    const provider = cols[0];
    const model = cols[1];
    const thinking = cols[cols.length - 2];
    if (!provider || !model) continue;
    models.push({
      id: `${provider}/${model}`,
      label: model,
      efforts: thinking === "yes" ? PI_THINKING_LEVELS.map((level) => ({ id: level })) : [],
    });
  }
  if (models.length === 0) return undefined;
  return { models };
}
