/**
 * The agent library's state, held where both panes can reach it.
 *
 * The list is on the right of the launch window and the editor replaces the
 * intro on the left, so neither can own the profiles: picking a profile is a
 * fact about the window rather than about either pane.
 *
 * Editing is a draft with an explicit Save. The store writes one local JSON
 * file, so saving on every keystroke was possible and was what this did — but
 * a form that saves invisibly gives you nothing to press and no moment where
 * you know the text is down. The cost of a draft is that there is now a way to
 * lose one, so every way out of the editor is guarded instead of any of them
 * being quietly destructive: see `leave`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { startingModels, type AgentModels } from "@anthill/workflow";

import type { GlobalAgentProfile, RecentWorkflow } from "../../shared/ipc.js";

export type AgentLibrary = ReturnType<typeof useAgentLibrary>;

/** The fields the editor writes. Identity and the clocks are the store's. */
export type AgentDraft = {
  name: string;
  role: string;
  description: string;
  /** The whole per-tool bag, because "no key" is one of its three states. */
  models: AgentModels;
};

/** A draft of a stored profile, with the absent optional fields flattened. */
function draftOf(profile: GlobalAgentProfile): AgentDraft {
  return {
    name: profile.name,
    role: profile.role ?? "",
    description: profile.description ?? "",
    models: { ...(profile.models ?? {}) },
  };
}

/**
 * Two bags, compared by what they say rather than by identity.
 *
 * Key order is not meaning here, and neither is object identity — without this
 * every render of a re-created bag would read as an unsaved change and the Save
 * button would never go quiet.
 */
function sameModels(a: AgentModels, b: AgentModels): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((key) => {
    const left = a[key as keyof AgentModels];
    const right = b[key as keyof AgentModels];
    return left?.id === right?.id && left?.reasoningEffort === right?.reasoningEffort;
  });
}

/**
 * What Save has to send.
 *
 * Only the fields that differ, and never a key with no value: the store reads
 * a mentioned field as one to write and an empty string as one to clear, and a
 * key carrying `undefined` survives IPC looking exactly like a deliberate one
 * — which is how choosing a model once wiped everything else on a profile.
 */
export function changesBetween(draft: AgentDraft, stored: GlobalAgentProfile): Partial<AgentDraft> {
  const was = draftOf(stored);
  const change: Partial<AgentDraft> = {};
  for (const key of ["name", "role", "description"] as const) {
    if (draft[key] !== was[key]) change[key] = draft[key];
  }
  // Sent whole when it differs at all: the store replaces the bag rather than
  // merging, because the absence of a tool's key is the message.
  if (!sameModels(draft.models, was.models)) change.models = draft.models;
  return change;
}

export function useAgentLibrary(workflows: RecentWorkflow[] | null) {
  const [profiles, setProfiles] = useState<GlobalAgentProfile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  /** The open profile as it is being edited. Undefined when nothing is open. */
  const [draft, setDraft] = useState<AgentDraft | undefined>();
  /**
   * The profile this session just made, so its name field takes the cursor.
   *
   * Only a new one: opening an existing profile should not steal focus from
   * the list somebody is arrowing through.
   */
  const [justCreated, setJustCreated] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  /** The profile whose Delete has been pressed once while a workflow uses it. */
  const [confirming, setConfirming] = useState<string | undefined>();
  /** Whether the last Save landed. Cleared when the draft changes again. */
  const [saveState, setSaveState] = useState<"none" | "saved" | "failed">("none");
  /**
   * Where the author was going when unsaved edits stopped them.
   *
   * Held rather than run, and never resolved on their behalf: the whole reason
   * a draft is safe to have is that no way out of the editor throws one away
   * without asking.
   */
  const [leaving, setLeaving] = useState<{ run: () => void } | undefined>();

  useEffect(() => {
    let live = true;
    void window.anthill
      .agentsList()
      .then((found) => {
        if (live) setProfiles(found);
      })
      .catch(() => {
        if (live) {
          setProfiles([]);
          setNote("Your agents could not be read. Nothing was changed.");
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const selected = profiles?.find((profile) => profile.id === selectedId);
  const dirty =
    Boolean(selected && draft) && Object.keys(changesBetween(draft!, selected!)).length > 0;

  /** The workflows holding a copy of a profile, by the id they point back at. */
  const usedBy = useCallback(
    (id: string) => (workflows ?? []).filter((item) => item.libraryAgentIds?.includes(id)),
    [workflows],
  );

  const show = useCallback((profile: GlobalAgentProfile, madeNow = false) => {
    setSelectedId(profile.id);
    setDraft(draftOf(profile));
    setJustCreated(madeNow ? profile.id : undefined);
    setConfirming(undefined);
    setSaveState("none");
    setLeaving(undefined);
  }, []);

  const shut = useCallback(() => {
    setSelectedId(undefined);
    setDraft(undefined);
    setJustCreated(undefined);
    setConfirming(undefined);
    setSaveState("none");
    setLeaving(undefined);
  }, []);

  /**
   * Do something that would abandon the open draft — or ask first.
   *
   * Closing, opening another profile and leaving for the Workflows tab are the
   * same question, so they get one answer in one place. Nothing is lost while
   * that question is on screen: the draft is still there and the author picks.
   */
  const leave = useCallback(
    (run: () => void) => {
      if (!dirty) {
        run();
        return;
      }
      setLeaving({ run });
    },
    [dirty],
  );

  const open = useCallback(
    (profile: GlobalAgentProfile) => {
      setNote(undefined);
      leave(() => show(profile));
    },
    [leave, show],
  );

  const close = useCallback(() => leave(shut), [leave, shut]);

  const create = useCallback(() => {
    leave(() => {
      setNote(undefined);
      // Created in the file immediately, with no name. Creating is not an
      // edit: the row has to exist before there is a draft of it, and a
      // profile that did not exist until it was named would make Save mean
      // two different things.
      // With the author's starting answers, when they have given any
      // (ANT-135). Unreadable preferences are no preferences, not a failure.
      void Promise.resolve()
        .then(() => window.anthill.modelPreferencesRead())
        .catch(() => undefined)
        .then((preferences) => {
          const models = preferences ? startingModels(preferences) : undefined;
          return window.anthill.agentsCreate({ name: "", ...(models ? { models } : {}) });
        })
        .catch(() => undefined)
        .then((profile) => {
          if (!profile) {
            setNote("That agent could not be saved.");
            return;
          }
          setProfiles((current) => [profile, ...(current ?? [])]);
          show(profile, true);
        });
    });
  }, [leave, show]);

  /** Edit the draft. Nothing is written until Save. */
  const patch = useCallback((change: Partial<AgentDraft>) => {
    setDraft((current) => (current ? { ...current, ...change } : current));
    setSaveState("none");
  }, []);

  /** Put the draft in the file. Says whether it landed. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!selected || !draft) return true;
    const change = changesBetween(draft, selected);
    if (Object.keys(change).length === 0) return true;

    const saved = await window.anthill.agentsUpdate(selected.id, change).catch(() => undefined);
    if (!saved) {
      setSaveState("failed");
      setNote("That change could not be saved.");
      return false;
    }
    setProfiles((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
    setDraft(draftOf(saved));
    setSaveState("saved");
    setNote(undefined);
    return true;
  }, [draft, selected]);

  /** Save, then go. Staying put if the save did not land. */
  const saveAndLeave = useCallback(async () => {
    if (!(await save())) return;
    const going = leaving;
    setLeaving(undefined);
    going?.run();
  }, [leaving, save]);

  /** Throw the draft away and go. Only ever reachable from the question. */
  const discardAndLeave = useCallback(() => {
    const going = leaving;
    setLeaving(undefined);
    if (selected) setDraft(draftOf(selected));
    going?.run();
  }, [leaving, selected]);

  /** Change your mind about leaving; the draft was never touched. */
  const stay = useCallback(() => setLeaving(undefined), []);

  const duplicate = useCallback(
    (id: string) => {
      leave(() => {
        setConfirming(undefined);
        void window.anthill
          .agentsDuplicate(id)
          .catch(() => undefined)
          .then((copy) => {
            if (!copy) {
              setNote("That agent could not be duplicated.");
              return;
            }
            setProfiles((current) => [copy, ...(current ?? [])]);
            show(copy, true);
          });
      });
    },
    [leave, show],
  );

  const remove = useCallback(
    async (id: string) => {
      // A referenced profile takes a second press, and the first one says what
      // is referencing it. Nothing breaks either way — the workflows hold
      // their own copies — but a silent delete would leave the author guessing
      // whether it did.
      if (usedBy(id).length > 0 && confirming !== id) {
        setConfirming(id);
        return;
      }
      setConfirming(undefined);
      const gone = await window.anthill.agentsRemove(id).catch(() => false);
      if (!gone) {
        setNote("That agent could not be deleted.");
        return;
      }
      setProfiles((current) => (current ?? []).filter((item) => item.id !== id));
      // No unsaved-changes question on the way out: deleting the profile is
      // already an answer to what should happen to edits of it.
      setSelectedId(undefined);
      setDraft(undefined);
      setLeaving(undefined);
    },
    [confirming, usedBy],
  );

  /** Yours and the ones Anthill ships, kept apart. */
  const groups = useMemo(() => {
    const all = profiles ?? [];
    return {
      yours: all.filter((profile) => !profile.starter),
      ready: all.filter((profile) => profile.starter),
    };
  }, [profiles]);

  return {
    profiles,
    groups,
    selected,
    draft,
    dirty,
    leaving: Boolean(leaving),
    justCreated,
    confirming,
    saveState,
    note,
    count: profiles?.length ?? 0,
    usedBy,
    leave,
    open,
    close,
    create,
    patch,
    save,
    saveAndLeave,
    discardAndLeave,
    stay,
    duplicate,
    remove,
    setNote,
  };
}
