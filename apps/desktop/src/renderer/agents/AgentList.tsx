/**
 * The agent library's list, on the right of the launch window.
 *
 * Two groups, and the split is the point: somebody scanning for something to
 * reuse is asking a different question from somebody checking what they wrote.
 * Mixing them makes both harder.
 *
 * A ready-made profile is listed apart and behaves identically — same click,
 * same editor, same fields. Its provenance is a shade of rule and a heading,
 * nothing more.
 */

import type { GlobalAgentProfile } from "../../shared/ipc.js";

import { AgentRow } from "./AgentRow.js";
import { modelChips } from "./AgentEditor.js";

export type AgentListProps = {
  /** Null while the library is still being read. */
  profiles: GlobalAgentProfile[] | null;
  groups: { yours: GlobalAgentProfile[]; ready: GlobalAgentProfile[] };
  selectedId: string | undefined;
  filter: string;
  note: string | undefined;
  usedBy: (id: string) => readonly unknown[];
  onOpen: (profile: GlobalAgentProfile) => void;
};

function matches(profile: GlobalAgentProfile, needle: string): boolean {
  if (!needle) return true;
  return [
    profile.name,
    profile.role,
    profile.description,
    ...modelChips(profile.models).map((model) => model.label),
  ]
    .filter((part): part is string => Boolean(part))
    .some((part) => part.toLowerCase().includes(needle));
}

export function AgentList({
  profiles,
  groups,
  selectedId,
  filter,
  note,
  usedBy,
  onOpen,
}: AgentListProps) {
  const needle = filter.trim().toLowerCase();
  const yours = groups.yours.filter((profile) => matches(profile, needle));
  const ready = groups.ready.filter((profile) => matches(profile, needle));
  const shown = yours.length + ready.length;

  const rows = (group: GlobalAgentProfile[]) =>
    group.map((profile) => (
      <AgentRow
        key={profile.id}
        profile={profile}
        selected={profile.id === selectedId}
        uses={usedBy(profile.id).length}
        models={modelChips(profile.models)}
        onOpen={() => onOpen(profile)}
      />
    ));

  return (
    <div className="agent-list">
      {note ? (
        <p className="launch-note is-said" role="status">
          {note}
        </p>
      ) : null}

      {profiles === null ? <p className="launch-note">Looking for your agents…</p> : null}

      {profiles !== null && profiles.length > 0 && shown === 0 ? (
        <p className="launch-note">Nothing matches “{filter.trim()}”.</p>
      ) : null}

      {/* The heading carries the absence, which is why no row has to. */}
      {profiles !== null && (yours.length > 0 || !needle) ? (
        <div className="agent-group-head">
          <span className="agent-group-label">Yours</span>
          <i className="rule" />
          <span className="agent-group-count">{yours.length}</span>
        </div>
      ) : null}
      {profiles !== null && yours.length === 0 && !needle ? (
        <p className="launch-note">
          No agents of your own yet. Write one here and it is ready to drop into any
          workflow — or add one inside a workflow, where it stays that workflow&rsquo;s own.
        </p>
      ) : null}
      {rows(yours)}

      {ready.length > 0 ? (
        <div className="agent-group-head">
          <span className="agent-group-label is-ready">Ready-made</span>
          <i className="rule" />
          <span className="agent-group-count">{ready.length}</span>
        </div>
      ) : null}
      {rows(ready)}
    </div>
  );
}
