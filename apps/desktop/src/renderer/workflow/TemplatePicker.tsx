/**
 * Starting point for a new workflow.
 *
 * Shown instead of dropping the author onto a canvas that is either blank or
 * pre-filled with someone else's example: neither says what a workflow looks like.
 * A template opens as an ordinary editable workflow.
 */

import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@anthill/workflow";

export type TemplatePickerProps = {
  /**
   * The workflow this screen was opened over, when there is one. Every screen
   * with a workflow open names it beside the screen's own name, so the bar
   * always says both what you are looking at and what it is about.
   */
  workflowName?: string;
  onPick: (template: WorkflowTemplate) => void;
  onBlank: () => void;
  onOpen: () => void;
  /** Start from a written description instead of a shape. */
  onFromPrompt: () => void;
  onCancel?: () => void;
};

/**
 * A glyph strip showing the shape of a workflow — start, steps, an approval gate,
 * a loop, an end. Says more at a glance than the description does.
 */
const SHAPES: Record<string, string[]> = {
  "one-agent-solve": ["start", "step", "step", "step", "end"],
  "brainstorm-to-workflow": ["start", "step", "step", "gate", "loop", "step", "step", "end"],
  "implement-test-fix": ["start", "step", "step", "loop", "step", "end"],
  "consult-adversarial-decide": ["start", "step", "step", "step", "gate", "loop", "step", "end"],
  "multi-agent-coordination": ["start", "step", "step", "step", "step", "loop", "end"],
  "artifact-improvement": ["start", "step", "step", "loop", "step", "step", "end"],
};

function Shape({ parts }: { parts: string[] }) {
  return (
    <div className="shape" aria-hidden="true">
      {parts.map((part, index) => (
        <i key={`${part}-${index}`} className={`s-${part}`} />
      ))}
    </div>
  );
}

export function TemplatePicker({
  onPick,
  onBlank,
  onOpen,
  onFromPrompt,
  onCancel,
  workflowName,
}: TemplatePickerProps) {
  return (
    <div className="app">
      <div className="subbar">
        {onCancel ? (
          <button className="icon-button" onClick={onCancel} title="Back">
            ←
          </button>
        ) : null}
        <span className="brand">New workflow</span>
        {workflowName ? <span className="screen-subject">{workflowName}</span> : null}
        <span className="spacer" />
        <button onClick={onOpen}>Open file…</button>
      </div>

      <div className="template-body">
        <h1>Start a workflow</h1>
        <p className="lede">
          Pick a shape to start from. Everything in it is editable — templates
          are ordinary workflows, not a special mode.
        </p>

        <button className="prompt-card" onClick={onFromPrompt}>
          <div className="head">
            <span className="kicker">From a prompt</span>
          </div>
          <h2>Describe the work instead</h2>
          <p>
            Paste a description of what needs doing and a coding CLI you already
            have installed proposes a workflow. You see it before anything is
            created, and edit it on the canvas afterwards.
          </p>
          <small>
            Runs locally with your own sign-in. No API key, nothing to connect.
          </small>
        </button>

        <div className="template-grid">
          {WORKFLOW_TEMPLATES.map((template, index) => (
            <button
              key={template.id}
              className="template-card"
              onClick={() => onPick(template)}
            >
              <div className="head">
                <span className="kicker">Template</span>
                <span className="number">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <h2>{template.name}</h2>
              <Shape parts={SHAPES[template.id] ?? ["start", "step", "end"]} />
              <p>{template.summary}</p>
              <small>{template.whenToUse}</small>
            </button>
          ))}

          <button className="template-card" onClick={onBlank}>
            <div className="head">
              <span className="kicker">Blank</span>
              <span className="number">
                {String(WORKFLOW_TEMPLATES.length + 1).padStart(2, "0")}
              </span>
            </div>
            <h2>Blank workflow</h2>
            <Shape parts={["start", "end"]} />
            <p>A Start block and an End block, already connected.</p>
            <small>You know the shape you want and would rather build it yourself.</small>
          </button>
        </div>
      </div>
    </div>
  );
}
