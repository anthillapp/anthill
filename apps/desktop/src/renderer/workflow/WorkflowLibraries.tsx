/**
 * The left rail: what a workflow is composed *from*.
 *
 * Blocks and agents are the same kind of thing — reusable pieces you draw on —
 * so they belong together and on screen whatever happens to be selected. Agents
 * used to sit in the right sidebar's tab group, which meant clicking a block on
 * the canvas navigated away from the agent you were reading. A library that a
 * canvas click can close is not a library.
 *
 * The rail owns no editing. Choosing an agent here opens it in the one
 * inspector, where blocks and connections are edited too, so a profile has a
 * single home rather than two half-homes.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { agentProfiles } from "@anthill/workflow";

import { AgentRail } from "./AgentLibrary.js";
import { BlockLibrary, totalBlockCount, type CustomBlock, type LibraryBlock } from "./BlockLibrary.js";

export type LibraryTab = "blocks" | "agents";

export type WorkflowLibrariesProps = {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  tab: LibraryTab;
  onTabChange: (tab: LibraryTab) => void;
  custom: CustomBlock[];
  onAddCustom: (block: CustomBlock) => void;
  onAddBlock: (block: LibraryBlock) => void;
  selectedAgentId?: string;
  onSelectAgent: (agentId: string | undefined) => void;
};

export function WorkflowLibraries({
  workflow,
  onChange,
  tab,
  onTabChange,
  custom,
  onAddCustom,
  onAddBlock,
  selectedAgentId,
  onSelectAgent,
}: WorkflowLibrariesProps) {
  const agents = agentProfiles(workflow);
  const blockCount = totalBlockCount(custom);

  return (
    <aside className="libraries">
      <div className="library-switch" role="tablist" aria-label="Libraries">
        <button
          role="tab"
          aria-selected={tab === "blocks"}
          className={tab === "blocks" ? "active" : ""}
          onClick={() => onTabChange("blocks")}
        >
          Blocks<span className="count">{blockCount}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "agents"}
          className={tab === "agents" ? "active" : ""}
          onClick={() => onTabChange("agents")}
        >
          Agents<span className="count">{agents.length}</span>
        </button>
      </div>

      {tab === "blocks" ? (
        <BlockLibrary custom={custom} onAddCustom={onAddCustom} onAdd={onAddBlock} />
      ) : (
        <AgentRail
          workflow={workflow}
          onChange={onChange}
          {...(selectedAgentId ? { selectedId: selectedAgentId } : {})}
          onSelect={onSelectAgent}
        />
      )}
    </aside>
  );
}
