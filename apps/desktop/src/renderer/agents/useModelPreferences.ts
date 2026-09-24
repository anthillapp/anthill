/**
 * The author's model preferences, for every screen that offers a model
 * (ANT-135): the Settings page that edits them, and both agent editors that
 * follow them.
 *
 * Read once per mount and written through whole. Until the first read lands,
 * the defaults stand in — the same answer the file gives when it is missing —
 * so an editor never has to render a "loading preferences" state for what is
 * a few hundred bytes on local disk.
 */

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_MODEL_PREFERENCES, type ModelPreferences } from "@anthill/workflow";

export function useModelPreferences() {
  const [preferences, setPreferences] = useState<ModelPreferences>(DEFAULT_MODEL_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  /** Why the last write was refused, until the next attempt. */
  const [unsaved, setUnsaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Through a promise from the first step, so a bridge without the call — an
    // older preload, a test's partial stub — reads as the defaults instead of
    // throwing out of the effect.
    Promise.resolve()
      .then(() => window.anthill.modelPreferencesRead())
      .then((read) => {
        if (live && read) setPreferences(read);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(async (next: ModelPreferences) => {
    setUnsaved(null);
    try {
      // What the store kept, not what was asked for: it normalises.
      setPreferences(await window.anthill.modelPreferencesWrite(next));
    } catch (error) {
      // The screen keeps showing what is stored — which is the previous
      // value — and says the change did not stick (ANT-97's rule).
      setUnsaved(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return { preferences, loaded, unsaved, save };
}
