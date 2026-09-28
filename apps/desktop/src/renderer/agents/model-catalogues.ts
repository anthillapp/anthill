/**
 * The models a tool offers on this machine, for every editor that asks.
 *
 * Two editors offer an agent a model: the global library's, which has a card
 * per tool, and the workflow's own, which edits one target. They used to read
 * different sources. The library asked the app for Codex's discovered
 * catalogue; the workflow editor read the harness table — which is empty for
 * Codex on purpose, because Codex's models are discovered rather than declared
 * — and so offered a Codex workflow "Default" and nothing else (ANT-127). What
 * is shared here is the data and the rule for reading it, so the two cannot
 * drift apart again; the markup stays each editor's own.
 */

import { useCallback, useEffect, useState } from "react";
import { harnessProfile } from "@anthill/workflow";
import type { HarnessTarget } from "@anthill/workflow-schema";

import type { CodexModelCatalog, CodexModelOption, PiModelCatalog } from "../../shared/ipc.js";

export type ModelCatalogues = {
  /** Codex's own catalogue, or undefined when Anthill has not been told. */
  codex: CodexModelCatalog | undefined;
  /** What pi listed for this machine, or undefined when the CLI could not be reached. */
  pi: PiModelCatalog | undefined;
  /**
   * Which lists are still being asked for. Not given and not yet answered are
   * different, and only the first is worth a warning (ANT-169).
   */
  loading?: { codex?: boolean; pi?: boolean };
};

/**
 * The last lists this window was given, for the next editor that asks.
 *
 * The workflow's agent editor is remounted for every agent opened, and each
 * mount asked again — so the warning that no list had been given flashed on
 * every switch, and stayed for as long as Codex took to answer (ANT-169).
 * A new mount starts from what the window already knows and asks again
 * behind it.
 */
const known: { codex?: CodexModelCatalog; pi?: PiModelCatalog } = {};

/**
 * The discovered catalogues, read once for the window.
 *
 * Asked for rather than hard-coded: a copy of somebody else's model list kept
 * in Anthill's source goes stale on their release schedule, and a stale entry
 * here becomes an agent file that fails at the far end. A failure costs the
 * list, not the editor — `undefined` says "not given", which is not the same
 * as an empty list, and the editors say the difference.
 */
export function useModelCatalogues(): ModelCatalogues & { reload: () => void } {
  const [codex, setCodex] = useState<CodexModelCatalog | undefined>(known.codex);
  const [pi, setPi] = useState<PiModelCatalog | undefined>(known.pi);
  const [loading, setLoading] = useState({ codex: true, pi: true });
  // Bumped to read again. Settings offers a Refresh (ANT-135): a model
  // released since the window opened is otherwise invisible until a relaunch.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    // Through a promise from the first step, so a bridge that lacks the call
    // altogether — an older preload, a test's partial stub — rejects like a
    // failed read instead of throwing out of the effect and taking the
    // editor with it.
    setLoading({ codex: true, pi: true });
    Promise.resolve()
      .then(() => window.anthill.codexModels())
      .then((found) => {
        // The latest answer stands, whatever it is; the remembered list only
        // fills the moment before it arrives.
        known.codex = found;
        if (live) setCodex(found);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading((current) => ({ ...current, codex: false }));
      });
    Promise.resolve()
      .then(() => window.anthill.piModels())
      .then((found) => {
        known.pi = found;
        if (live) setPi(found);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading((current) => ({ ...current, pi: false }));
      });
    return () => {
      live = false;
    };
  }, [generation]);

  return { codex, pi, loading, reload };
}

/**
 * What one tool offers: declared for Claude Code, discovered for Codex and pi.
 *
 * A discovered list Anthill has not been given comes back empty, and the
 * caller must not read that as "this tool offers nothing" — it is a list
 * nobody handed over. `catalogueMissing` is the question to ask.
 */
export function modelOptionsFor(
  target: HarnessTarget,
  catalogues: ModelCatalogues,
): CodexModelOption[] {
  const harness = harnessProfile(target);
  if (harness.modelsAreDeclared) {
    return harness.models.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
      efforts: [],
    }));
  }
  if (target === "codex") return catalogues.codex?.models ?? [];
  if (target === "pi") return catalogues.pi?.models ?? [];
  return [];
}

/** Whether a tool whose models are discovered has had none discovered yet. */
export function catalogueMissing(target: HarnessTarget, catalogues: ModelCatalogues): boolean {
  if (harnessProfile(target).modelsAreDeclared) return false;
  // Still being asked: not missing yet (ANT-169).
  if ((target === "codex" || target === "pi") && catalogues.loading?.[target] && modelOptionsFor(target, catalogues).length === 0) {
    return false;
  }
  return modelOptionsFor(target, catalogues).length === 0;
}

/**
 * A stored answer the tool no longer offers — a model retired since it was
 * chosen, most often. Kept and shown rather than quietly dropped or silently
 * replaced: it is the author's decision, and a picker that had reset itself
 * to something else would be the worst of the three outcomes. Only judged
 * against a list that was actually given; an empty discovered list retires
 * nothing.
 */
export function retiredChoice(
  chosen: string | undefined,
  options: readonly CodexModelOption[],
  sentinel: string,
): string | undefined {
  if (!chosen || chosen === sentinel || options.length === 0) return undefined;
  return options.some((option) => option.id === chosen) ? undefined : chosen;
}
