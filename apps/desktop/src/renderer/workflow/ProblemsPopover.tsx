/**
 * The workflow's problems, as an index and only as an index.
 *
 * Every problem is also readable on the block or connection it belongs to —
 * that is where someone actually fixes it. This list exists for the other
 * question: "what is left?". So it is a popover under the top-bar pill rather
 * than a panel competing for the sidebar, and picking a row selects the thing
 * the problem is about and gets out of the way.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Workflow } from "@anthill/workflow-schema";
import type { WorkflowIssue } from "@anthill/workflow";

export type ProblemTarget =
  | { kind: "block"; nodeId: string }
  | { kind: "edge"; nodeId: string; edgeId: string };

export type ProblemsPopoverProps = {
  workflow: Workflow;
  issues: WorkflowIssue[];
  onClose: () => void;
  /** Select the thing a problem belongs to. Absent for workflow-wide problems. */
  onGo: (target: ProblemTarget) => void;
  /**
   * The control this hangs from.
   *
   * Measured rather than guessed, and portalled to the body: the top bar clips
   * its overflow, so a popover positioned inside it is trimmed to the height of
   * the bar, and a hard-coded offset drifts the moment a button beside it
   * changes width.
   */
  anchor?: React.RefObject<HTMLElement | null>;
};

/**
 * What a row points at.
 *
 * An issue already carries the node or edge it was raised against, so the
 * target is derived rather than stored twice — two records of the same fact
 * drift, and a row that navigates to the wrong block is worse than one that
 * does not navigate at all.
 */
export function targetOf(workflow: Workflow, issue: WorkflowIssue): ProblemTarget | undefined {
  if (issue.edgeId) {
    const edge = workflow.edges.find((item) => item.id === issue.edgeId);
    if (edge) return { kind: "edge", nodeId: edge.source, edgeId: edge.id };
  }
  if (issue.nodeId) return { kind: "block", nodeId: issue.nodeId };
  return undefined;
}

export function ProblemsPopover({
  workflow,
  issues,
  onClose,
  onGo,
  anchor,
}: ProblemsPopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const box = anchor?.current?.getBoundingClientRect();
    setSpot(box ? { top: box.bottom + 8, right: window.innerWidth - box.right } : { top: 52, right: 16 });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // A frame's delay, so the click that opened this does not close it.
    const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const errors = issues.filter((issue) => issue.severity === "error").length;

  return createPortal(
    <div
      className="problems-popover"
      ref={panel}
      role="dialog"
      aria-label="Problems"
      style={spot ? { top: spot.top, right: spot.right } : undefined}
    >
      <header>
        <strong>
          {errors > 0 ? `${errors} to fix` : "Nothing to fix"}
          {issues.length > errors ? ` · ${issues.length - errors} to consider` : ""}
        </strong>
      </header>

      {/*
        Not "ready to generate": "Ready" now means "the work may begin" on a
        handover a few centimetres away, and this pill is about the graph. It
        also says what it does not know, because an empty problems list is the
        moment somebody is most likely to read it as approval.
      */}
      {issues.length === 0 ? (
        <p className="empty">
          Nothing to fix. Anthill checks that the graph compiles into a prompt – it says nothing
          about whether the work is right.
        </p>
      ) : null}

      <ol>
        {issues.map((issue, index) => {
          const target = targetOf(workflow, issue);
          const where = issue.nodeId
            ? (workflow.nodes.find((node) => node.id === issue.nodeId)?.name ?? issue.nodeId)
            : issue.edgeId
              ? "A connection"
              : "The workflow";
          return (
            <li key={`${issue.code}-${index}`}>
              <button
                className={`problem ${issue.severity}`}
                disabled={!target}
                onClick={() => {
                  if (!target) return;
                  onGo(target);
                  onClose();
                }}
                title={target ? "Select it" : "This is about the workflow as a whole"}
              >
                <span className="where">
                  {where}
                  <span className={`chip ${issue.severity}`}>
                    {issue.severity === "error" ? "must fix" : "advisory"}
                  </span>
                </span>
                <span className="what">{issue.message}</span>
                <code className="code">{issue.code}</code>
              </button>
            </li>
          );
        })}
      </ol>

      <p className="problems-foot">
        Every problem is also shown on the block or connection it belongs to.
      </p>
    </div>,
    document.body,
  );
}
