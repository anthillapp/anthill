/**
 * The first screen: pick what Anthill should do this session.
 *
 * Orchestrator is shown but disabled, and says plainly why. Hiding it would be
 * tidier; leaving it visible is more honest about where the product is going.
 */

export type Mode = "workflow" | "orchestrator";

export type ModeSelectProps = {
  onPick: (mode: Mode) => void;
};

export function ModeSelect({ onPick }: ModeSelectProps) {
  return (
    <div className="mode-select">
      <aside className="mode-aside">
        <div className="brand-row">
          <span className="logo-mark" aria-hidden="true" />
          Anthill
        </div>
        <p>
          Design workflows for AI coding agents, then hand the workflow to the agent
          that will carry it out.
        </p>
        <hr />
        <p className="disclaimer">
          Anthill workflows work. It does not run it — the workflows it produces are
          instructions for an external coding agent.
        </p>
      </aside>

      <main className="mode-main">
        <h1>Where shall we start?</h1>
        <p className="lede">
          Two ways to work. Only the first is finished.
        </p>

        <div className="modes">
          <button className="mode-card" onClick={() => onPick("workflow")}>
            <div className="head">
              <span className="glyph" aria-hidden="true" />
              <h2>Workflow</h2>
              <span className="pill on">Available</span>
            </div>
            <p>
              Draw the workflow — steps, who carries them out, the conditions
              between them and where they stop — and get a prompt you can paste
              into a coding agent, with the subagent files that back it.
            </p>
            <div className="chips">
              <span className="chip">11 actions</span>
              <span className="chip">5 templates</span>
              <span className="chip">Claude Code · Codex</span>
            </div>
          </button>

          <button className="mode-card" disabled>
            <div className="head">
              <span className="glyph" aria-hidden="true" />
              <h2>Orchestrator</h2>
              <span className="pill off">Not finished</span>
            </div>
            <p>
              Run the workflow from here: Anthill drives the agent CLIs itself,
              streams progress and keeps a history of every run.
            </p>
            <div className="chips">
              <span className="chip">CLI invocation unverified</span>
            </div>
          </button>
        </div>
      </main>
    </div>
  );
}
