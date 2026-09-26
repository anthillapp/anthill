/**
 * The selected output: what it means, where it goes, and when it is taken.
 *
 * The condition is built with a guided control rather than a text box — the
 * grammar is a dotted path, `==` or `!=`, and a literal, so free text mostly
 * produces expressions the validator rejects.
 */

import { useMemo } from "react";
import {
  parseEdgeCondition,
  type ValidationResult,
  type EdgeRouting,
  type OutcomeKind,
  type Workflow,
} from "@anthill/workflow-schema";
import {
  OUTCOME_LABELS,
  OUTCOME_MEANINGS,
  actionDefinition,
  agentConfig,
  agentForNode,
  agentSlug,
  assignedAgents,
  findOutput,
  patchOutput,
  removeOutput,
  setOutputTarget,
} from "@anthill/workflow";
import { issuesForEdge } from "@anthill/workflow";
import { OUTCOME_STYLES } from "@anthill/builder";
import { IssueList } from "./IssueList.js";

export type OutputInspectorProps = {
  workflow: Workflow;
  nodeId: string;
  outputId: string;
  onChange: (next: Workflow) => void;
  onStartLinking: (nodeId: string, outputId: string) => void;
  onCleared: () => void;
  /** Select a block — used by the source → target row at the top. */
  onSelectStep?: (nodeId: string) => void;
  /** What is wrong with the workflow, so this connection can show its own share. */
  validation: ValidationResult;
};

type ConditionParts = {
  source: string;
  field: string;
  operator: "==" | "!=";
  value: string;
};

const EMPTY: ConditionParts = { source: "", field: "decision", operator: "==", value: "" };

/** How the arrow is drawn. Presentation only — both mean the same thing. */
const LINE_STYLES = [
  { value: "curved", label: "Curved" },
  { value: "orthogonal", label: "Stepped" },
] as const satisfies readonly { value: EdgeRouting; label: string }[];

function toCondition(parts: ConditionParts): string | undefined {
  if (!parts.source || !parts.field || parts.value === "") return undefined;
  return `${parts.source}.${parts.field} ${parts.operator} ${JSON.stringify(parts.value)}`;
}

function fromCondition(condition: string | undefined): ConditionParts {
  if (!condition) return EMPTY;
  const parsed = parseEdgeCondition(condition);
  if (!parsed.ok) return EMPTY;
  const [source, ...rest] = parsed.condition.path;
  return {
    source: source ?? "",
    field: rest.join(".") || "decision",
    operator: parsed.condition.operator,
    value: String(parsed.condition.value),
  };
}

export function OutputInspector({
  workflow,
  nodeId,
  outputId,
  onChange,
  onStartLinking,
  onCleared,
  onSelectStep,
  validation,
}: OutputInspectorProps) {
  const output = findOutput(workflow, nodeId, outputId);
  const source = workflow.nodes.find((node) => node.id === nodeId);

  const agents = useMemo(
    () => assignedAgents(workflow).map((item) => item.profile),
    [workflow],
  );
  const sourceAgent = source ? agentForNode(workflow, source.id) : undefined;
  const sourceAction =
    source?.type === "agent" && agentConfig(source).actionKind
      ? actionDefinition(agentConfig(source).actionKind as never)
      : undefined;

  if (!output || !source) {
    return (
      <div className="tab-body">
        <h2>Connection</h2>
        <p className="empty">Select an arrow or an output to edit it.</p>
      </div>
    );
  }

  const target = output.target
    ? workflow.nodes.find((node) => node.id === output.target)
    : undefined;
  const parts = fromCondition(output.condition);

  const setParts = (patch: Partial<ConditionParts>) => {
    const next = { ...parts, ...patch };
    onChange(patchOutput(workflow, nodeId, outputId, { condition: toCondition(next) }));
  };

  return (
    <div className="tab-body">
      <h2>Output · {OUTCOME_LABELS[output.kind]}</h2>
      <h3>{output.label || OUTCOME_LABELS[output.kind]}</h3>

      {/* Both ends are buttons: a connection is mostly read on the way to one
          of the blocks it joins, and making them selectable saves a hunt across
          the canvas for a block whose name you are already looking at. */}
      <div className="connection-ends">
        <button
          className="connection-end"
          onClick={() => onSelectStep?.(source.id)}
          disabled={!onSelectStep}
        >
          {source.name}
        </button>
        <span className="connection-arrow" aria-hidden="true">
          →
        </span>
        {target ? (
          <button
            className="connection-end"
            onClick={() => onSelectStep?.(target.id)}
            disabled={!onSelectStep}
          >
            {target.name}
          </button>
        ) : (
          <span className="connection-end is-loose">not connected</span>
        )}
      </div>

      <p className="hint">{OUTCOME_MEANINGS[output.kind]}</p>

      <IssueList issues={issuesForEdge(validation, outputId)} />

      <label className="field">
        <span>Label on the arrow</span>
        <input
          value={output.label}
          placeholder="e.g. tests failed"
          onChange={(event) =>
            onChange(patchOutput(workflow, nodeId, outputId, { label: event.target.value }))
          }
        />
      </label>

      <div className="two-up">
        <label className="field">
          <span>Kind</span>
          <select
            value={output.kind}
            onChange={(event) =>
              onChange(
                patchOutput(workflow, nodeId, outputId, {
                  kind: event.target.value as OutcomeKind,
                }),
              )
            }
          >
            {(Object.keys(OUTCOME_LABELS) as OutcomeKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {OUTCOME_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Leads to</span>
          <select
            value={output.target ?? ""}
            onChange={(event) =>
              onChange(
                // Choosing from the list has no click point, so the anchor is
                // cleared and the arrow slides along the nearest side instead.
                setOutputTarget(
                  workflow,
                  nodeId,
                  outputId,
                  event.target.value || null,
                  null,
                ),
              )
            }
          >
            <option value="">Not connected</option>
            {workflow.nodes
              .filter((node) => node.id !== nodeId)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {sourceAction ? (
        <p className="hint">
          <strong>{sourceAction.label}</strong> usually continues:{" "}
          {sourceAction.typicalNextPaths.join("; ")}.
        </p>
      ) : null}

      <span className="field-label">Follow this connection when</span>
      <div className="two-up" style={{ marginTop: 4, marginBottom: 8 }}>
        <select
          value={parts.source}
          onChange={(event) => setParts({ source: event.target.value })}
        >
          <option value="">always</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agentSlug(agent)}>
              {agentSlug(agent)}
            </option>
          ))}
        </select>

        <input
          value={parts.field}
          placeholder="field"
          list="condition-fields"
          disabled={!parts.source}
          onChange={(event) => setParts({ field: event.target.value })}
        />
        <datalist id="condition-fields">
          <option value="decision" />
          <option value="status" />
          <option value="summary" />
        </datalist>

        <select
          value={parts.operator}
          disabled={!parts.source}
          onChange={(event) => setParts({ operator: event.target.value as "==" | "!=" })}
        >
          <option value="==">is</option>
          <option value="!=">is not</option>
        </select>

        <input
          value={parts.value}
          placeholder="value"
          list="condition-values"
          disabled={!parts.source}
          onChange={(event) => setParts({ value: event.target.value })}
        />
        <datalist id="condition-values">
          {(sourceAction?.decisionValues ?? []).map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>

      <div
        className="prompt"
        style={{ maxHeight: "none", marginBottom: 12, padding: "9px 11px" }}
      >
        {output.condition ?? "always – this connection is followed whenever the step finishes"}
      </div>

      {sourceAction?.decisionValues?.length ? (
        <p className="hint">
          Quick pick:{" "}
          {sourceAction.decisionValues.map((value) => (
            <button
              key={value}
              className="link"
              style={{ marginRight: 8 }}
              onClick={() =>
                setParts({
                  source: sourceAgent ? agentSlug(sourceAgent) : parts.source,
                  field: "decision",
                  operator: "==",
                  value,
                })
              }
            >
              {value}
            </button>
          ))}
        </p>
      ) : null}

      <span className="field-label">Line</span>
      <div className="segmented">
        {LINE_STYLES.map((style) => (
          <button
            key={style.value}
            className={(output.routing ?? "curved") === style.value ? "active" : undefined}
            onClick={() =>
              onChange(patchOutput(workflow, nodeId, outputId, { routing: style.value }))
            }
          >
            {style.label}
          </button>
        ))}
      </div>
      <p className="hint">
        Drag the diamond at the middle of the line to bend it, and the port to
        move it around its block. Double-click the diamond to straighten the
        line again.
      </p>
      {output.bend || output.port ? (
        <div className="row">
          <button
            onClick={() =>
              onChange(
                patchOutput(workflow, nodeId, outputId, { bend: null, port: null }),
              )
            }
          >
            Reset shape
          </button>
        </div>
      ) : null}

      <p className="hint">
        Drag the arrowhead on the canvas, or use Re-route, to point this
        somewhere else. Delete detaches it and keeps the port.
      </p>

      <div className="row">
        <button
          onClick={() => onStartLinking(nodeId, outputId)}
          style={{ borderColor: OUTCOME_STYLES[output.kind].color }}
        >
          Re-route
        </button>
        <button
          onClick={() => {
            onChange(removeOutput(workflow, nodeId, outputId));
            onCleared();
          }}
        >
          Remove output
        </button>
      </div>
    </div>
  );
}
