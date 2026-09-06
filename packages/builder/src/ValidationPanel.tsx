/**
 * ValidationPanel: live list of local structural validation errors.
 *
 * Recomputed from the workflow on every render, so it always reflects the
 * current document. Clicking an error that points at a node selects it.
 */

import { useMemo } from "react";

import type { ValidationError, ValidationResult, Workflow } from "./contracts";
import { validate } from "./validate";
import { Button, Panel } from "./ui-local";

export type ValidationPanelProps = {
  workflow: Workflow;
  /** Pre-computed result; when omitted the panel validates the workflow itself. */
  result?: ValidationResult;
  onSelectNode?: (nodeId: string) => void;
  className?: string;
};

export function ValidationPanel({
  workflow,
  result,
  onSelectNode,
  className,
}: ValidationPanelProps) {
  const computed = useMemo(
    () => result ?? validate(workflow),
    [result, workflow],
  );

  return (
    <Panel
      title="Validation"
      aside={
        <span data-testid="validation-count">
          {computed.valid
            ? "No issues"
            : `${computed.errors.length} issue${computed.errors.length === 1 ? "" : "s"}`}
        </span>
      }
      className={className}
    >
      {computed.valid ? (
        <p>Workflow is structurally valid.</p>
      ) : (
        <ul data-testid="validation-errors">
          {computed.errors.map((error, index) => (
            <li key={`${error.code}-${error.nodeId ?? error.edgeId ?? index}`}>
              <ErrorRow error={error} onSelectNode={onSelectNode} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ErrorRow({
  error,
  onSelectNode,
}: {
  error: ValidationError;
  onSelectNode?: (nodeId: string) => void;
}) {
  const message = (
    <>
      <code>{error.code}</code> {error.message}
    </>
  );
  if (error.nodeId && onSelectNode) {
    const nodeId = error.nodeId;
    return <Button onClick={() => onSelectNode(nodeId)}>{message}</Button>;
  }
  return <span>{message}</span>;
}

export default ValidationPanel;
