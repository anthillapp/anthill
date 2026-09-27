/**
 * Where an ended session's time and recorded tokens went (ANT-142).
 *
 * Collapsed to one line under the graph; opened, it floats over the canvas
 * and does not move it. Three levels, each only as strong as its source:
 *
 * - **Session** — the observed duration and the tokens the CLI recorded,
 *   labelled *recorded*, because a harness can record some work and not other.
 * - **By block** — each step's announced time, its presumed share of the
 *   tokens (`~`), its passes and where it ended. A step that looped opens into
 *   its passes, one line each, because three passes through Run tests should
 *   read as three rows — that is what makes a stuck or expensive step obvious.
 * - **By agent** — totals over the steps the workflow *assigned* to each agent
 *   that were actually reached. It says it is grouped by assignment: the
 *   record does not say which runtime agent really did the work.
 *
 * Tokens recorded outside any step are shown on their own line and are never
 * spread over the steps. Missing data reads "no data" — never 0 — and a step
 * never reached has no numbers, because nothing ran there to measure.
 */

import { Fragment, useState } from "react";
import { CLI_LABEL, type MarkerCli } from "@anthill/live";

import { readDuration } from "./feed.js";
import { compact, tokenLine, type SessionUsage } from "./report.js";

export type UsagePanelProps = {
  usage: SessionUsage;
  cli: MarkerCli;
  /** Select one step and show its events. */
  onPickBlock: (blockId: string) => void;
  /** Show the events of every step an agent was assigned. */
  onPickAgent: (name: string, blockIds: string[]) => void;
};

const OUTCOME_LABEL = {
  done: "done",
  failed: "failed",
  unknown: "unknown",
  notReached: "not reached",
  waiting: "waiting on you",
} as const;

export function UsagePanel({ usage, cli, onPickBlock, onPickAgent }: UsagePanelProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>();
  const recorded = usage.tokensRecorded;

  return (
    <section className={`usage-panel${open ? " is-open" : ""}`} aria-label="Usage">
      <button type="button" className="usage-line" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="kicker">Usage</span>
        <span>
          {usage.durationMs !== undefined ? readDuration(usage.durationMs) : "duration not known"}
          {" · "}
          {recorded ? `${compact(recorded.in)} in · ${compact(recorded.out)} out tokens recorded` : "no tokens recorded"}
        </span>
        <span className="spacer" />
        <span className="usage-toggle">{open ? "Hide" : "By block and agent"}</span>
      </button>

      {open ? (
        <div className="usage-body">
          <div className="usage-col">
            <span className="kicker">By block</span>
            <table className="usage-table">
              <tbody>
                {usage.blocks.map((block) => {
                  const reached = block.passes.length > 0;
                  const looped = block.passes.length > 1;
                  return (
                    <Fragment key={block.blockId}>
                      <tr className={`is-${block.outcome}`}>
                        <th scope="row">
                          <button
                            type="button"
                            className="usage-row-name"
                            aria-expanded={looped ? expanded === block.blockId : undefined}
                            onClick={() =>
                              looped
                                ? setExpanded((current) => (current === block.blockId ? undefined : block.blockId))
                                : onPickBlock(block.blockId)
                            }
                          >
                            {block.name}
                          </button>
                        </th>
                        <td>{reached ? (block.durationMs !== undefined ? readDuration(block.durationMs) : "no end") : "–"}</td>
                        <td>{reached || block.tokens ? tokenLine(block.tokens, true) : "–"}</td>
                        <td className="passes">×{block.passes.length}</td>
                        <td className="outcome">{OUTCOME_LABEL[block.outcome]}</td>
                      </tr>
                      {looped && expanded === block.blockId
                        ? block.passes.map((pass) => (
                            <tr key={pass.pass} className="usage-pass">
                              <th scope="row">Pass {pass.pass}</th>
                              <td>{pass.durationMs !== undefined ? readDuration(pass.durationMs) : "no end"}</td>
                              <td>{tokenLine(pass.tokens, true)}</td>
                              <td colSpan={2}>
                                <button type="button" className="link" onClick={() => onPickBlock(block.blockId)}>
                                  Show events
                                </button>
                              </td>
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {usage.tokensUnattributed ? (
              <p className="usage-note">
                Could not be assigned to a block: {compact(usage.tokensUnattributed.in)} in ·{" "}
                {compact(usage.tokensUnattributed.out)} out tokens
              </p>
            ) : null}
          </div>

          <div className="usage-col">
            <span className="kicker">By agent · as the workflow assigned them</span>
            {usage.agents.length > 0 ? (
              <ul className="usage-agents">
                {usage.agents.map((agent) => (
                  <li key={agent.name}>
                    <button type="button" onClick={() => onPickAgent(agent.name, agent.blockIds)}>
                      <strong>{agent.name}</strong>
                      <span className="usage-agent-blocks">
                        {agent.blockIds
                          .map((id) => usage.blocks.find((block) => block.blockId === id)?.name ?? id)
                          .join(", ")}
                      </span>
                    </button>
                    <span>{agent.durationMs !== undefined ? readDuration(agent.durationMs) : "no end"}</span>
                    <span>{tokenLine(agent.tokens, true)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="usage-note">No step the workflow assigned to an agent was reached.</p>
            )}
            <p className="usage-note">
              Tokens are recorded by {CLI_LABEL[cli]}; ~ marks a presumed split, read from the step
              they were recorded for – a subagent&rsquo;s count goes to the step it was started from.
              Block time runs from a step&rsquo;s start until the session moves on and its subagents
              are back, so it can include waiting, and steps run side by side overlap.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
