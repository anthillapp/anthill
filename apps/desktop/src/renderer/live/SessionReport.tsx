/**
 * The top of an ended session: what happened, and what came of it (ANT-142).
 *
 * One line, collapsed by default, and the whole line is the toggle — the
 * graph and the feed below are the evidence, and a report that pushed them
 * off the screen would be answering the question by hiding the working.
 * Opened, it floats over the graph rather than moving it.
 *
 * Everything it counts is counted from the drawn scene, so a chip here and a
 * block on the canvas can never disagree; every chip leads to the blocks or
 * the events it counted. The agent's last words are shown as the agent's —
 * "Claude Code said…" — because Anthill did not check any of it. And a
 * finished session is never drawn as a success: its edge is grey, and it says
 * outright that finishing is not the same as the work being right.
 *
 * What is not here is deliberate too. There is no "files changed" or "tests
 * passed" line, because nothing Anthill records is a trustworthy source for
 * either; reading them out of the agent's prose would be the confident wrong
 * answer this page exists to avoid.
 */

import { useState } from "react";
import type { Workflow } from "@anthill/workflow-schema";
import { CLI_LABEL, type LiveSessionView, type PendingRun } from "@anthill/live";

import { readDuration } from "./feed.js";
import { MessageMarkup } from "./message-markup.js";
import {
  END_TITLE,
  OUTCOME_ORDER,
  compact,
  lastWords,
  outcomes,
  outcomeWord,
  verdictSource,
  type EndState,
  type Outcome,
  type SessionUsage,
} from "./report.js";

export type SessionReportProps = {
  workflow: Workflow;
  run: PendingRun;
  view: LiveSessionView;
  end: EndState;
  usage: SessionUsage;
  /** When the session ended, as the report states it. */
  endedAt?: string;
  /** Select one step and show its events. */
  onPickBlock: (blockId: string) => void;
  /** Show the activity no step could be claimed for. */
  onUnmapped: () => void;
};

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function SessionReport({ workflow, run, view, end, usage, endedAt, onPickBlock, onUnmapped }: SessionReportProps) {
  const [open, setOpen] = useState(false);
  /** Which block each chip showed last, so a second click moves to the next one. */
  const [cursor, setCursor] = useState<Partial<Record<Outcome, number>>>({});
  const cli = CLI_LABEL[run.selectedCli];
  const counts = outcomes(workflow, view);
  const words = lastWords(view, end);
  const loops = usage.blocks.filter((block) => block.passes.length > 1);
  const name = (blockId: string) => workflow.nodes.find((node) => node.id === blockId)?.name ?? blockId;

  // A session that ended at an Approval Gate nobody answered did not finish
  // the workflow; it stopped where a person has to decide (ANT-176).
  const gate =
    end === "completed"
      ? workflow.nodes.find((node) => node.type === "approval" && view.blocks[node.id]?.state === "needsYou")
      : undefined;
  const title = gate ? `Stopped at ${gate.name}` : END_TITLE[end];

  const chips = OUTCOME_ORDER.filter((outcome) => (counts.get(outcome)?.length ?? 0) > 0);
  // The collapsed line names only what ended somewhere, not every empty bucket.
  const summary = chips.map((outcome) => outcomeWord(outcome, counts.get(outcome)!.length)).join(" · ");

  const pick = (outcome: Outcome) => {
    const ids = counts.get(outcome) ?? [];
    if (ids.length === 0) return;
    const next = ((cursor[outcome] ?? -1) + 1) % ids.length;
    setCursor((prev) => ({ ...prev, [outcome]: next }));
    onPickBlock(ids[next]);
  };

  return (
    <section className={`session-report is-${end}${open ? " is-open" : ""}`} aria-label="Session report">
      <button
        type="button"
        className="session-report-line"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <strong>{title}</strong>
        {endedAt ? <span className="quiet">{end === "lost" ? "Last read" : "Ended"} {clock(endedAt)}</span> : null}
        {summary ? <span className="session-report-counts">{summary}</span> : null}
        <span className="spacer" />
        <span className="session-report-toggle">{open ? "Hide" : "What happened"}</span>
        {/* Drawn, not typed: the ⌄ glyph sits on its font's baseline and drops
            below the label beside it. */}
        <i className="chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div className="session-report-body">
          <p className="session-report-source">
            {view.startedAt ? `Started ${clock(view.startedAt)} · ` : ""}
            {endedAt ? `${end === "lost" ? "last read" : "ended"} ${clock(endedAt)}` : "end not recorded"}
            {usage.durationMs !== undefined ? ` · ${readDuration(usage.durationMs)} observed` : ""}
            {" · from "}
            {verdictSource(end, view.events)}
          </p>

          {words ? (
            <blockquote className={`session-report-words${words.asksUser ? " is-asking" : ""}`}>
              <span className="kicker">
                {words.asksUser
                  ? `Waiting on you · ${cli} asked`
                  : words.stale
                    ? "Last message received · may be out of date"
                    : `${cli} said`}
              </span>
              {/* Rendered the way the feed card renders the same message, so the
                  report does not print raw Markdown and local links (ANT-148). */}
              <MessageMarkup text={words.text} />
              <span className="session-report-caveat">
                In the agent&rsquo;s words, as {cli} recorded them – Anthill did not check them.
              </span>
            </blockquote>
          ) : (
            <p className="session-report-words is-empty">
              No message from the agent was recorded, so there is nothing in its own words to show.
            </p>
          )}

          <div className="session-report-chips" role="group" aria-label="On the workflow">
            <span className="kicker">On the workflow</span>
            {chips.map((outcome) => {
              const ids = counts.get(outcome)!;
              return (
                <button
                  key={outcome}
                  type="button"
                  className={`report-chip is-${outcome}`}
                  title={`Show ${ids.map(name).join(", ")} on the graph, with its events`}
                  onClick={() => pick(outcome)}
                >
                  <i aria-hidden="true" />
                  {outcomeWord(outcome, ids.length)}
                </button>
              );
            })}
            {loops.map((block) => (
              <button
                key={block.blockId}
                type="button"
                className="report-chip is-loop"
                title={`Show ${block.name}'s passes and events`}
                onClick={() => onPickBlock(block.blockId)}
              >
                <i aria-hidden="true" />
                {block.name} ran {block.passes.length} passes
              </button>
            ))}
            {view.unmappedCount > 0 ? (
              <button type="button" className="report-chip is-unmapped" onClick={onUnmapped}>
                <i aria-hidden="true" />
                {view.unmappedCount} event{view.unmappedCount === 1 ? "" : "s"} not tied to a step
              </button>
            ) : null}
          </div>

          <p className="session-report-details">
            {usage.durationMs !== undefined ? `Duration ${readDuration(usage.durationMs)}` : "Duration not known"}
            {" · "}
            {usage.tokensRecorded
              ? `${compact(usage.tokensRecorded.in)} in · ${compact(usage.tokensRecorded.out)} out tokens, as recorded by ${cli}`
              : `no tokens recorded by ${cli}`}
            .{" "}
            {end === "completed"
              ? "Finished is not the same as succeeded – check the result before accepting it."
              : end === "failed"
                ? "The session recorded an error – the failed step's events say what the record holds about it."
                : "Anthill stopped being able to read the session. It may have carried on working where Anthill cannot see."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
