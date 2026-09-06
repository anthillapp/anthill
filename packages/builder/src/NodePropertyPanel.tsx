/**
 * NodePropertyPanel: edits the currently selected node.
 *
 * MVP scope (deliberate): `agent` nodes get the full field set from
 * `docs/visual-builder.md` minus the structured ones (expected output schema,
 * retry policy, permissions) which need the real schema package. Every other
 * node type gets a minimal panel — name plus its single obvious config field.
 */

import type { NodeType, Workflow, WorkflowNode } from "./contracts";
import { NODE_TYPE_LABELS, renameNode, updateNodeConfig } from "./document";
import { Panel, TextAreaField, TextField } from "./ui-local";

export type NodePropertyPanelProps = {
  workflow: Workflow;
  selectedNodeId: string | null;
  onChange: (next: Workflow) => void;
  className?: string;
};

/** Single-line config fields rendered for non-agent node types. */
const SIMPLE_CONFIG_FIELDS: Partial<
  Record<NodeType, { key: string; label: string }>
> = {
  approval: { key: "prompt", label: "Approval prompt" },
  condition: { key: "expression", label: "Condition expression" },
  command: { key: "command", label: "Command" },
};

export function NodePropertyPanel({
  workflow,
  selectedNodeId,
  onChange,
  className,
}: NodePropertyPanelProps) {
  const node = selectedNodeId
    ? workflow.nodes.find((candidate) => candidate.id === selectedNodeId)
    : undefined;

  if (!node) {
    return (
      <Panel title="Node properties" className={className}>
        <p>Select a node to edit its properties.</p>
      </Panel>
    );
  }

  const setName = (name: string) => onChange(renameNode(workflow, node.id, name));
  const setConfig = (key: string, value: string) =>
    onChange(updateNodeConfig(workflow, node.id, { [key]: value }));

  return (
    <Panel
      title="Node properties"
      aside={<span>{NODE_TYPE_LABELS[node.type]}</span>}
      className={className}
    >
      <TextField label="Name" value={node.name} onChange={setName} />
      {node.type === "agent" ? (
        <AgentFields node={node} setConfig={setConfig} />
      ) : (
        <SimpleFields node={node} setConfig={setConfig} />
      )}
    </Panel>
  );
}

type FieldsProps = {
  node: WorkflowNode;
  setConfig: (key: string, value: string) => void;
};

function AgentFields({ node, setConfig }: FieldsProps) {
  return (
    <>
      <TextField
        label="Role"
        value={configText(node, "role")}
        placeholder="developer"
        onChange={(value) => setConfig("role", value)}
      />
      <TextField
        label="Runtime"
        value={configText(node, "runtime")}
        placeholder="claude-code"
        onChange={(value) => setConfig("runtime", value)}
      />
      <TextField
        label="Model"
        value={configText(node, "model")}
        onChange={(value) => setConfig("model", value)}
      />
      <TextAreaField
        label="Instructions"
        value={configText(node, "instructions")}
        rows={6}
        onChange={(value) => setConfig("instructions", value)}
      />
      <TextField
        label="Working directory"
        value={configText(node, "workingDirectory")}
        onChange={(value) => setConfig("workingDirectory", value)}
      />
      <TextField
        label="Success criteria"
        value={configText(node, "successCriteria")}
        onChange={(value) => setConfig("successCriteria", value)}
      />
    </>
  );
}

function SimpleFields({ node, setConfig }: FieldsProps) {
  const field = SIMPLE_CONFIG_FIELDS[node.type];
  if (!field) return null;
  return (
    <TextField
      label={field.label}
      value={configText(node, field.key)}
      onChange={(value) => setConfig(field.key, value)}
    />
  );
}

function configText(node: WorkflowNode, key: string): string {
  const value = node.config[key];
  return typeof value === "string" ? value : "";
}

export default NodePropertyPanel;
