/**
 * The selected block, as one column.
 *
 * It used to be four sub-tabs inside a tab inside a sidebar, which meant that
 * reading a step's problem, seeing which agent carries it out and checking
 * where it goes next were three different places. A step is one thing; it now
 * reads as one thing.
 *
 * The order answers the questions in the order people ask them: what is wrong
 * with this, what is it, who does it, where does it go, what does it consume
 * and produce, what bounds it. Sections are parted by a labelled hairline, so
 * the column is scannable without being navigable.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";
import {
  ACTION_CATEGORY_LABELS,
  ACTION_CATEGORY_ORDER,
  ACTION_LIBRARY,
  DEFAULT_TARGET,
  OUTCOME_LABELS,
  OUTCOME_MEANINGS,
  SWITCHER_NOTE,
  actionDefinition,
  addAgentProfile,
  addOutput,
  agentConfig,
  agentProfiles,
  agentSlug,
  approvalConfig,
  assignAgent,
  harnessProfile,
  isConfiguredFor,
  isSwitcher,
  modelFor,
  outputsOf,
  removeOutput,
  stepsUsingAgent,
  switcherProblem,
  type ActionKind,
  type BlockOutput,
} from "@anthill/workflow";
import { issuesForNode } from "@anthill/workflow";
import { OUTCOME_STYLES } from "@anthill/builder";
import type { ValidationResult } from "@anthill/workflow-schema";
import { IssueList } from "./IssueList.js";
import { agentFileName } from "./agent-file-name.js";
import { renameNode, updateNodeConfig } from "@anthill/builder";
import type { OutcomeKind } from "@anthill/workflow-schema";

export type BlockInspectorProps = {
  workflow: Workflow;
  node: WorkflowNode;
  onChange: (next: Workflow) => void;
  /** Start pointing an output at a block. */
  onStartLinking: (nodeId: string, outputId: string) => void;
  onSelectOutput: (nodeId: string, outputId: string) => void;
  /** What is wrong with the workflow, so this block can show its own share of it. */
  validation: ValidationResult;
  /** Open an agent in the inspector, with a way back to this step. */
  onEditAgent: (agentId: string) => void;
  /** Select another step — used to jump to the ones sharing this agent. */
  onSelectStep: (nodeId: string) => void;
};

/** The sections an issue's "fix" shortcut can scroll to. */
type Section = "task" | "data" | "limits";

/** The optional fields an action can flag as typical. See `ActionDefinition.suggestedFields`. */
type SuggestedField = "inputs" | "expectedOutput" | "successCriteria" | "constraints" | "handoff";

const UNUSED_SUB_TABS: { id: string; label: string }[] = [
  { id: "task", label: "Task" },
  { id: "data", label: "Data" },
  { id: "outputs", label: "Outputs" },
  { id: "limits", label: "Limits" },
];

/** Sentinel in the agent picker: create a profile and assign it in one move. */
const NEW_AGENT = "__new__";

const toLines = (values: string[] | undefined): string => (values ?? []).join("\n");

const fromLines = (text: string): string[] | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : undefined;
};

export function BlockInspector({
  workflow,
  node,
  onChange,
  onStartLinking,
  onSelectOutput,
  onEditAgent,
  onSelectStep,
  validation,
}: BlockInspectorProps) {
  /**
   * Scroll a section into view when an issue offers to take you there.
   *
   * The sub-tabs used to do this by swapping the panel's contents; with one
   * column the same promise is kept by moving the column instead.
   */
  const sections = useRef<Partial<Record<Section, HTMLDivElement | null>>>({});
  const [flash, setFlash] = useState<Section | undefined>();

  const goToSection = useCallback((section: Section) => {
    sections.current[section]?.scrollIntoView({ block: "start", behavior: "smooth" });
    setFlash(section);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(undefined), 1200);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const sectionProps = (id: Section) => ({
    ref: (element: HTMLDivElement | null) => {
      sections.current[id] = element;
    },
    className: `inspector-section${flash === id ? " is-flashed" : ""}`,
  });

  // The first unconnected output is what "Connect it" acts on: the issue is
  // reported against the block, and one button that connects the next loose
  // end is more use than none.
  const looseOutput = outputsOf(workflow, node.id).find((output) => output.target === null);
  const issues = issuesForNode(validation, node.id, {
    ...(looseOutput ? { unconnectedOutputId: looseOutput.id } : {}),
  });

  const inlineIssues = (
    <IssueList
      issues={issues}
      onGoToSection={goToSection}
      onConnectOutput={(outputId) => onStartLinking(node.id, outputId)}
      onEditAgent={() => {
        const assigned = agentConfig(node).agentId;
        if (assigned) onEditAgent(assigned);
      }}
    />
  );

  const setName = (name: string) => onChange(renameNode(workflow, node.id, name));
  const setConfig = (patch: Record<string, unknown>) =>
    onChange(updateNodeConfig(workflow, node.id, patch));

  // What points at this block. A step nothing reaches is a step the workflow
  // never runs, and the inspector should say so where the step is, not only in
  // an index somewhere else. A gate as well as a step: it was always shown
  // "In – 0", however many steps led into it (ANT-187).
  const incoming = workflow.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => ({
      edgeId: edge.id,
      sourceId: edge.source,
      sourceName: workflow.nodes.find((item) => item.id === edge.source)?.name ?? edge.source,
      label: edge.label,
      kind: edge.kind ?? "next",
    }));

  if (node.type === "approval") {
    const config = approvalConfig(node);
    return (
      <div className="tab-body">
        <h2>Control block · Approval gate</h2>
        <h3>{node.name}</h3>
        <p className="hint">
          The workflow stops here and asks a person. Label each path out of it with
          the answer it follows.
        </p>
        {inlineIssues}
        <label className="field">
          <span>Name</span>
          <input value={node.name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Question</span>
          <textarea
            rows={3}
            value={config.prompt ?? ""}
            placeholder="What the person is being asked to decide"
            onChange={(event) => setConfig({ prompt: event.target.value || undefined })}
          />
        </label>
        <OutputsList
          workflow={workflow}
          node={node}
          incoming={incoming}
          onChange={onChange}
          onStartLinking={onStartLinking}
          onSelectOutput={onSelectOutput}
        />
      </div>
    );
  }

  if (node.type !== "agent") {
    return (
      <div className="tab-body">
        <h2>Control block · {node.type === "start" ? "Start" : "End"}</h2>
        <h3>{node.name}</h3>
        <p className="hint">
          {node.type === "start"
            ? "The workflow starts here. Connect it to the first step."
            : "The workflow stops here."}
        </p>
        {inlineIssues}
        <label className="field">
          <span>Name</span>
          <input value={node.name} onChange={(event) => setName(event.target.value)} />
        </label>
        {node.type === "start" ? (
          <OutputsList
            workflow={workflow}
            node={node}
            onChange={onChange}
            onStartLinking={onStartLinking}
            onSelectOutput={onSelectOutput}
          />
        ) : null}
      </div>
    );
  }

  const config = agentConfig(node);
  const definition = config.actionKind ? actionDefinition(config.actionKind) : undefined;
  const profile = harnessProfile(workflow.target ?? DEFAULT_TARGET);
  const agents = agentProfiles(workflow);
  const agent = agents.find((item) => item.id === config.agentId);
  const sharedWith = agent
    ? stepsUsingAgent(workflow, agent.id).filter((step) => step.id !== node.id)
    : [];

  /** Create an agent and assign it to this step in one move. */
  const createAgentForStep = () => {
    const created = addAgentProfile(workflow, { name: "" });
    onChange(assignAgent(created.workflow, node.id, created.agentId));
    onEditAgent(created.agentId);
  };

  const chooseAction = (kind: ActionKind) => {
    const next = actionDefinition(kind);
    // Only seed fields left empty, so switching action does not wipe writing.
    setConfig({
      actionKind: kind,
      purpose: config.purpose ?? next.defaultPurpose,
      inputs: config.inputs ?? next.suggestedInputs,
      expectedOutput: config.expectedOutput ?? next.defaultExpectedOutput,
      successCriteria: config.successCriteria ?? next.defaultSuccessCriteria,
    });
  };

  // Which of the optional fields the chosen action calls out as typical, so the
  // author sees what usually matters here first. A hint, not a gate — every
  // field below stays editable regardless of whether it is flagged.
  const suggested = new Set<SuggestedField>(definition?.suggestedFields ?? []);
  const fieldHint = (key: SuggestedField) =>
    suggested.has(key) ? <span className="field-hint">Typical for this action</span> : null;

  return (
    <div className="tab-body">
      <h2>
        {definition
          ? `${ACTION_CATEGORY_LABELS[definition.category]} · ${definition.label}`
          : "Step"}
      </h2>
      <h3>{node.name || "Untitled step"}</h3>

      <div className="chips">
        {agent ? (
          <span className="chip">{agent.name || "Unnamed agent"}</span>
        ) : (
          <span className="chip idle">No agent</span>
        )}
        {/* The model this step will actually compile with, in this workflow's
            harness. A chip carrying the other harness's choice would be a
            claim about a run that is not going to happen. */}
        {agent && isConfiguredFor(agent.models, profile.target) ? (
          <span className="chip">{modelFor(agent.models, profile.target)}</span>
        ) : null}
        {config.maxIterations ? (
          <span className="chip">×{config.maxIterations} passes</span>
        ) : null}
      </div>

      {inlineIssues}

      <div {...sectionProps("task")}>
        <span className="section-label">Task</span>
          <label className="field">
            <span>Name</span>
            <input value={node.name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="two-up">
            <label className="field">
              <span>Action</span>
              <select
                value={config.actionKind ?? ""}
                onChange={(event) => chooseAction(event.target.value as ActionKind)}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {ACTION_CATEGORY_ORDER.map((category) => (
                  <optgroup key={category} label={ACTION_CATEGORY_LABELS[category]}>
                    {Object.values(ACTION_LIBRARY)
                      .filter((item) => item.category === category)
                      .map((item) => (
                        <option key={item.kind} value={item.kind}>
                          {item.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>

          </div>

          <label className="field">
            <span>Why this step exists</span>
            <input
              value={config.purpose ?? ""}
              placeholder={definition?.defaultPurpose}
              onChange={(event) => setConfig({ purpose: event.target.value || undefined })}
            />
          </label>

          <label className="field">
            <span>Task</span>
            <textarea
              rows={6}
              value={config.task ?? ""}
              placeholder="What this step must do"
              onChange={(event) => setConfig({ task: event.target.value || undefined })}
            />
          </label>

          {profile.agentDir && agent ? (
            <p className="hint">
              Generated as <code>{agentFileName(profile, agent)}</code>
            </p>
          ) : null}
      </div>

      <div className="inspector-section">
        <span className="section-label">Carried out by</span>

        <div className="carried-by">
          <span className={agent ? "carried-name" : "carried-name is-missing"}>
            {agent ? agent.name || "Unnamed agent" : "No agent"}
          </span>
          {agent ? (
            <button className="link" onClick={() => onEditAgent(agent.id)}>
              Open agent
            </button>
          ) : null}
        </div>

          <div className="note calm">
            {agent ? (
              <>
                {sharedWith.length > 0 ? (
                  <>
                    <strong>{agent.name || "This agent"}</strong> also does{" "}
                    {sharedWith.map((step, index) => (
                      <span key={step.id}>
                        {index > 0 ? ", " : ""}
                        <button className="link" onClick={() => onSelectStep(step.id)}>
                          {step.name || "an untitled step"}
                        </button>
                      </span>
                    ))}{" "}
                    – one agent, several stages, one generated file.
                  </>
                ) : (
                  <>
                    Only this step uses <strong>{agent.name || "this agent"}</strong>.
                    Assign it to another step to make them the same agent.
                  </>
                )}{" "}
                <button className="link" onClick={() => onEditAgent(agent.id)}>
                  Edit agent
                </button>
              </>
            ) : (
              "Every step needs an agent to carry it out. Pick one, or create a new one."
            )}
          </div>


        <label className="field">
          <span>Assign</span>
          <select
            value={config.agentId ?? ""}
            onChange={(event) => {
              if (event.target.value === NEW_AGENT) createAgentForStep();
              else onChange(assignAgent(workflow, node.id, event.target.value));
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || "Unnamed agent"}
              </option>
            ))}
            <option value={NEW_AGENT}>New agent…</option>
          </select>
        </label>
      </div>

      <div className="inspector-section">
        <span className="section-label">Connections</span>
        <OutputsList
          workflow={workflow}
          node={node}
          onChange={onChange}
          onStartLinking={onStartLinking}
          onSelectOutput={onSelectOutput}
          incoming={incoming}
        />
      </div>

      <div {...sectionProps("data")}>
        <span className="section-label">Data</span>
          <label className="field">
            <span>Inputs – one per line{fieldHint("inputs")}</span>
            <textarea
              rows={3}
              value={toLines(config.inputs)}
              placeholder={definition?.suggestedInputs.join("\n")}
              onChange={(event) => setConfig({ inputs: fromLines(event.target.value) })}
            />
          </label>

          <label className="field">
            <span>Expected output{fieldHint("expectedOutput")}</span>
            <textarea
              rows={3}
              value={config.expectedOutput ?? ""}
              placeholder={definition?.defaultExpectedOutput}
              onChange={(event) =>
                setConfig({ expectedOutput: event.target.value || undefined })
              }
            />
          </label>

          <label className="field">
            <span>Succeeds when – one per line{fieldHint("successCriteria")}</span>
            <textarea
              rows={3}
              value={toLines(config.successCriteria)}
              placeholder={definition?.defaultSuccessCriteria.join("\n")}
              onChange={(event) =>
                setConfig({ successCriteria: fromLines(event.target.value) })
              }
            />
          </label>

          {definition?.decisionValues?.length ? (
            <>
              <span className="field-label">Decisions this action usually returns</span>
              <div className="chips">
                {definition.decisionValues.map((value) => (
                  <span key={value} className="chip">
                    {value}
                  </span>
                ))}
              </div>
            </>
          ) : null}
      </div>

      <div {...sectionProps("limits")}>
        <span className="section-label">Limits</span>
          <span className="field-label">Model</span>
          <p className="hint">
            {agent ? (
              <>
                <strong>{modelFor(agent.models, profile.target)}</strong>, from the{" "}
                {agent.name || "assigned"} agent. The model belongs to the agent,
                not the step, so every step it does uses the same one.{" "}
                <button className="link" onClick={() => onEditAgent(agent.id)}>
                  Change it
                </button>
              </>
            ) : (
              "Assign an agent to this step; the model comes from the agent."
            )}
          </p>

          <label className="field">
            <span>Max passes</span>
            <input
              type="number"
              min={1}
              value={config.maxIterations ?? ""}
              placeholder="Required if this step is in a loop"
              onChange={(event) =>
                setConfig({
                  maxIterations: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            />
          </label>
          <p className="hint">
            A loop also needs done criteria in the brief. A pass limit only says
            when to give up, not when the work is finished.
          </p>

          <label className="field">
            <span>Constraints for this step – one per line{fieldHint("constraints")}</span>
            <textarea
              rows={3}
              value={toLines(config.constraints)}
              placeholder="Workflow-wide constraints live in the brief"
              onChange={(event) =>
                setConfig({ constraints: fromLines(event.target.value) })
              }
            />
          </label>

          <label className="field">
            <span>Hand off{fieldHint("handoff")}</span>
            <textarea
              rows={3}
              value={config.handoff ?? ""}
              placeholder="What to pass on, and to whom, when this step finishes"
              onChange={(event) => setConfig({ handoff: event.target.value || undefined })}
            />
          </label>
      </div>
    </div>
  );
}

function OutputsList({
  workflow,
  node,
  onChange,
  onStartLinking,
  onSelectOutput,
  incoming = [],
}: {
  incoming?: {
    edgeId: string;
    sourceId: string;
    sourceName: string;
    label?: string;
    kind: string;
  }[];
  workflow: Workflow;
  node: WorkflowNode;
  onChange: (next: Workflow) => void;
  onStartLinking: (nodeId: string, outputId: string) => void;
  onSelectOutput: (nodeId: string, outputId: string) => void;
}) {
  const outputs = outputsOf(workflow, node.id);
  const nameOf = (id: string) =>
    workflow.nodes.find((item) => item.id === id)?.name ?? id;

  // Two or more connected switch exits are one choice, taken exactly once.
  const switcher = isSwitcher(outputs);
  const problem = switcher ? switcherProblem(outputs) : undefined;

  const add = (kind: OutcomeKind, label?: string) => {
    const { workflow: next, outputId } = addOutput(workflow, node.id, kind, label);
    onChange(next);
    // A new output has nowhere to go yet, so go straight to pointing it.
    onStartLinking(node.id, outputId);
  };

  return (
    <>
      <span className="field-label">In – {incoming.length}</span>
      {incoming.length === 0 && node.type !== "start" ? (
        <p className="empty">Nothing points here yet, so the workflow never reaches this step.</p>
      ) : null}
      {incoming.map((edge) => (
        <button
          key={edge.edgeId}
          className="connection-row"
          onClick={() => onSelectOutput(edge.sourceId, edge.edgeId)}
        >
          <span className="connection-from">{edge.sourceName}</span>
          <span className="connection-kind">{edge.label ?? edge.kind}</span>
        </button>
      ))}

      <span className="field-label">Out – {outputs.length}</span>
      <p className="hint">
        An arrow always leaves from an output and may land anywhere on the block
        it points at.
      </p>

      {outputs.length === 0 ? (
        <p className="empty">Nothing leaves this block yet.</p>
      ) : null}

      {outputs.map((output: BlockOutput) => (
        <div
          key={output.id}
          className="problem"
          style={{ borderLeftColor: OUTCOME_STYLES[output.kind].color, cursor: "pointer" }}
          onClick={() => onSelectOutput(node.id, output.id)}
        >
          <div className="where">
            {output.label || OUTCOME_LABELS[output.kind]}
          </div>
          <div className="what">
            {OUTCOME_LABELS[output.kind]} ·{" "}
            {output.target ? `leads to ${nameOf(output.target)}` : "not connected"}
          </div>
          {output.condition ? <div className="code">{output.condition}</div> : null}
          <div className="row" style={{ marginTop: 8, marginBottom: 0 }}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onStartLinking(node.id, output.id);
              }}
            >
              {output.target ? "Re-route" : "Point it"}
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onChange(removeOutput(workflow, node.id, output.id));
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: 12 }}>
        {(["next", "rework", "switch", "question"] as const).map((kind) =>
          kind === "switch" ? (
            <button
              key={kind}
              className="add-switch"
              onClick={() => add(kind, "choice")}
              title="The agent chooses one of several paths."
            >
              <i aria-hidden="true" />+ {OUTCOME_LABELS[kind]}
            </button>
          ) : (
            <button key={kind} onClick={() => add(kind)} title={OUTCOME_MEANINGS[kind]}>
              + {OUTCOME_LABELS[kind]}
            </button>
          ),
        )}
      </div>
      {switcher ? (
        <>
          {problem ? (
            <p className="switch-warn" role="alert">
              {problem}
            </p>
          ) : null}
          <p className="switch-note">{SWITCHER_NOTE}</p>
        </>
      ) : null}
    </>
  );
}
