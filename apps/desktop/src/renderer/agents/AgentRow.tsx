/**
 * One profile in the library list.
 *
 * The whole row is a single button. It used to carry a trailing `Edit` label,
 * which duplicated what clicking the row already did and — being a span —
 * advertised an action it could not perform. One button also means no nested
 * interactive elements to trap a keyboard in.
 *
 * The rule down its left side is provenance: graphite for a profile somebody
 * wrote, pale for one Anthill ships. A rule rather than an icon tile, because
 * it says that one thing without adding a second visual system to the row.
 */

import type { GlobalAgentProfile } from "../../shared/ipc.js";

export type AgentRowProps = {
  profile: GlobalAgentProfile;
  selected: boolean;
  /** How many workflows hold a copy. Zero says nothing at all. */
  uses: number;
  /** One per tool the profile has chosen for. Empty when nobody has. */
  models: { target: string; tool: string; label: string }[];
  onOpen: () => void;
};

export function AgentRow({ profile, selected, uses, models, onOpen }: AgentRowProps) {
  const named = profile.name.trim().length > 0;

  return (
    <button
      type="button"
      className="agent-row"
      {...(selected ? { "aria-current": "true" as const } : {})}
      onClick={onOpen}
    >
      <i className={`agent-mark${profile.starter ? " is-ready" : ""}`} aria-hidden="true" />
      <span className="agent-row-text">
        <span className="agent-row-top">
          <span className={`agent-name${named ? "" : " is-unnamed"}`}>
            {named ? profile.name : "Unnamed agent"}
          </span>
          {/* One chip per tool this agent has been answered for, and none when
              it has been answered for none — a profile can be written long
              before any tool is connected, and a pill saying so on every such
              row would be the most repeated words on the screen saying the
              least. The tooltip carries the tool, so the word is never
              ambiguous between two vocabularies. */}
          {models.map((model) => (
            <span key={model.target} className="agent-model is-explicit" title={model.tool}>
              {model.label}
            </span>
          ))}
          {named ? null : <span className="agent-needs-name">needs a name</span>}
        </span>
        {profile.description ? (
          <span className="agent-summary">{profile.description}</span>
        ) : null}
        {/* Only where there is usage: an "in no workflow" pill on every row
            made the most repeated words on screen the ones saying nothing. */}
        {uses > 0 ? (
          <span className="agent-usage">
            In {uses} workflow{uses === 1 ? "" : "s"}
          </span>
        ) : null}
      </span>
    </button>
  );
}
