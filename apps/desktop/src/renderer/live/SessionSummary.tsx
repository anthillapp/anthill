/**
 * The summary a settled session has earned.
 *
 * Shown only once the run is settled — completed, failed, or closed as lost —
 * because a summary of work still happening would be a running commentary
 * pretending to be an accounting. Everything on it is folded from the journal,
 * so the same panel comes back identical after a restart.
 *
 * The two tiers stay visibly apart. Durations come from the agent's own step
 * announcements and are stated plainly. Tokens are whatever the harness chose
 * to record: the session figure is labelled *recorded* rather than *total*,
 * per-step figures appear only where a recording fell inside an announced step
 * and wear the same "Likely" the feed uses for that inference, and a missing
 * figure reads "not recorded" — never zero, which would be a different claim.
 */

import { useMemo } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import {
  CLI_LABEL,
  sessionMetrics,
  timeByAgent,
  type AttributedEvent,
  type PendingRun,
  type TokenTally,
} from "@anthill/live";
import { agentProfiles } from "@anthill/workflow";

import { readDuration } from "./feed.js";

export type SessionSummaryProps = {
  workflow: Workflow;
  run: PendingRun;
  events: AttributedEvent[];
};

/** Whether the run has settled enough for a summary to be honest. */
export function summaryDue(run: PendingRun): boolean {
  if (run.state === "completed" || run.state === "failed") return true;
  return run.state === "observation_lost" && Boolean(run.closedAt);
}

const tally = (tokens: TokenTally) =>
  `${tokens.in.toLocaleString()} in · ${tokens.out.toLocaleString()} out`;

export function SessionSummary({ workflow, run, events }: SessionSummaryProps) {
  const metrics = useMemo(
    () => sessionMetrics(events, run.lastObservedAt ?? run.closedAt),
    [events, run.lastObservedAt, run.closedAt],
  );

  const blockName = (blockId: string) =>
    workflow.nodes.find((node) => node.id === blockId)?.name ?? blockId;

  const clock = (at: string) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const agentName = useMemo(() => {
    const profiles = new Map(agentProfiles(workflow).map((p) => [p.id, p.name]));
    return (blockId: string) => {
      const node = workflow.nodes.find((item) => item.id === blockId);
      const agentId = node ? (node.config as { agentId?: string }).agentId : undefined;
      return agentId ? profiles.get(agentId) : undefined;
    };
  }, [workflow]);

  const agents = useMemo(() => timeByAgent(metrics, agentName), [metrics, agentName]);

  if (metrics.spans.length === 0 && !metrics.tokensRecorded) return null;

  return (
    <section className="session-summary" aria-label="Session summary">
      <span className="kicker">How the session went</span>

      {metrics.spans.length > 0 ? (
        <table className="summary-steps">
          <tbody>
            {metrics.spans.map((span) => (
              <tr key={`${span.blockId}:${span.pass}`}>
                <td className="summary-step-name">
                  {blockName(span.blockId)}
                  {(metrics.passesByBlock.get(span.blockId) ?? 1) > 1 ? (
                    <span className="summary-pass"> · pass {span.pass}</span>
                  ) : null}
                </td>
                <td
                  className="summary-figure"
                  // The span's own boundaries, for whoever needs the clock
                  // times rather than the arithmetic.
                  title={
                    span.endedAt
                      ? `${clock(span.startedAt)} – ${clock(span.endedAt)}`
                      : `announced at ${clock(span.startedAt)}`
                  }
                >
                  {span.durationMs !== undefined ? readDuration(span.durationMs) : "no end marker"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {agents.size > 0 ? (
        <dl className="summary-agents">
          {[...agents.entries()].map(([name, ms]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{readDuration(ms)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <dl className="summary-tokens">
        <div>
          <dt>Tokens the session recorded</dt>
          <dd>{metrics.tokensRecorded ? tally(metrics.tokensRecorded) : "not recorded"}</dd>
        </div>
        {[...metrics.tokensLikelyByBlock.entries()].map(([blockId, tokens]) => (
          <div key={blockId}>
            <dt>
              {blockName(blockId)} <span className="conf conf-likely">Likely</span>
            </dt>
            <dd>{tally(tokens)}</dd>
          </div>
        ))}
      </dl>

      <p className="summary-boundary">
        Times come from the steps the agent announced; tokens are what{" "}
        {CLI_LABEL[run.selectedCli]} recorded for itself, which can be partial and differs by
        harness. Anthill measured nothing.
      </p>
    </section>
  );
}
