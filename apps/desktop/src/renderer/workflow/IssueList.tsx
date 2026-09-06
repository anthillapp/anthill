/**
 * A thing's validation issues, shown where the thing is edited.
 *
 * The Problems list is an index; it is not where anyone works. Someone who has
 * selected a block and cannot see why it is marked has to leave it, read a
 * list, find their way back, and hope they remembered. So the same issues also
 * appear on the block and the connection they belong to, with a control that
 * puts the author in front of the field rather than describing where it is.
 */

import type { WorkflowIssue } from "@anthill/workflow";

export type IssueListProps = {
  issues: WorkflowIssue[];
  /** Scroll the inspector to the section a step's fix lives in. */
  onGoToSection?: (section: "task" | "data" | "limits") => void;
  onConnectOutput?: (outputId: string) => void;
  onEditAgent?: () => void;
};

export function IssueList({
  issues,
  onGoToSection,
  onConnectOutput,
  onEditAgent,
}: IssueListProps) {
  if (issues.length === 0) return null;

  const errors = issues.filter((issue) => issue.severity === "error").length;

  return (
    <div className="issues">
      <span className="field-label">
        {errors > 0
          ? `${errors} to fix${
              issues.length > errors ? ` · ${issues.length - errors} to consider` : ""
            }`
          : `${issues.length} to consider`}
      </span>

      {issues.map((issue, index) => {
        // The fix a given issue offers decides which handler it gets; an issue
        // whose handler is missing shows no button rather than a dead one.
        const act = (() => {
          const fix = issue.fix;
          if (!fix) return undefined;
          if (fix.kind === "step-field" && onGoToSection) return () => onGoToSection(fix.tab);
          if (fix.kind === "connect-output" && onConnectOutput) {
            return () => onConnectOutput(fix.outputId);
          }
          if (fix.kind === "edit-agent" && onEditAgent) return onEditAgent;
          return undefined;
        })();

        return (
          <div key={`${issue.code}-${index}`} className={`issue ${issue.severity}`}>
            <span className="issue-severity">
              {issue.severity === "error" ? "Must fix" : "Advisory"}
            </span>
            <code className="issue-code">{issue.code}</code>
            <span className="issue-message">{issue.message}</span>
            {act && issue.fix ? (
              <button className="link" onClick={act}>
                {issue.fix.label}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
