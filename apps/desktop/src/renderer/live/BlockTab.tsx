/**
 * The Block tab of the Activity panel (ANT-268): one step, as designed and as
 * it ran.
 *
 * Read-only. It shows the step from the workflow this run was started from —
 * its kind, name and purpose, what it was asked to do, where each of its
 * outputs leads — under how the session actually got through it. Editing
 * happens in the workflow, never during a run, and the footnote says so
 * rather than leaving the reader to look for a control that is not here.
 */

import type { BlockRunState } from "@anthill/live";
import type { Workflow } from "@anthill/workflow-schema";
import { OUTCOME_STYLES } from "@anthill/builder";
import { OUTCOME_LABELS, agentConfig, agentProfiles, approvalConfig, outputsOf } from "@anthill/workflow";

import { HowItRan } from "./HowItRan.js";
import { kicker } from "./LiveWorkflowGraph.js";
import type { BlockUsage } from "./report.js";

export type BlockTabProps = {
  workflow: Workflow;
  blockId: string;
  state: BlockRunState;
  usage: BlockUsage | undefined;
  ended: boolean;
  /** How many feed items the step has. */
  events: number;
  onShowEvents: () => void;
};

export function BlockTab({ workflow, blockId, state, usage, ended, events, onShowEvents }: BlockTabProps) {
  const node = workflow.nodes.find((item) => item.id === blockId);
  if (!node) return null;
  const config = agentConfig(node);
  const task = node.type === "approval" ? approvalConfig(node).prompt : config.task;
  const agent = config.agentId
    ? agentProfiles(workflow).find((profile) => profile.id === config.agentId)?.name
    : undefined;
  const name = (id: string) => workflow.nodes.find((item) => item.id === id)?.name ?? id;
  const outputs = outputsOf(workflow, blockId);
  const carriesWork = node.type === "agent" || node.type === "command";

  return (
    <div className="block-tab" role="tabpanel" aria-label={`${node.name}, as designed and as it ran`}>
      <div>
        <span className="block-kicker">{kicker(node)}</span>
        <h3 className="block-title">{node.name}</h3>
        {config.purpose ? <p className="block-purpose">{config.purpose}</p> : null}
      </div>

      <HowItRan block={usage} state={state} ended={ended} events={events} onShowEvents={onShowEvents} />

      {carriesWork || node.type === "approval" ? (
        <div>
          <span className="block-label">{node.type === "approval" ? "Question" : "Task"}</span>
          <p className={`block-task${task ? "" : " is-none"}`}>{task ?? "No task written yet."}</p>
        </div>
      ) : null}

      {outputs.length > 0 ? (
        <div>
          <span className="block-label">Outputs</span>
          <ul className="block-ports">
            {outputs.map((output) => (
              <li key={output.id} className="block-port">
                <span>
                  <i style={{ background: OUTCOME_STYLES[output.kind].color }} aria-hidden="true" />
                  <b>{output.label || OUTCOME_LABELS[output.kind]}</b>
                  <em>{OUTCOME_LABELS[output.kind]}</em>
                  <span className="block-port-to">
                    {output.target ? `→ ${name(output.target)}` : "not connected"}
                  </span>
                </span>
                {output.condition ? <code>when {output.condition}</code> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {carriesWork ? (
        <div className="block-facts">
          {config.maxIterations !== undefined ? (
            <span>
              <b>{config.maxIterations}</b> max passes
            </span>
          ) : null}
          <span>
            Agent <b>{agent ?? "No agent"}</b>
          </span>
        </div>
      ) : null}

      <p className="block-footnote">As designed. Editing happens in the workflow, not during a run.</p>
    </div>
  );
}
