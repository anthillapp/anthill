/**
 * Scene 3 — the same three steps, with what Anthill could observe.
 *
 * One step finished, one working, one not reached, and the third is why this
 * scene is the last thing the screen says: Anthill draws what the records
 * support and leaves the rest plainly unknown.
 *
 * The bar on the working card is indeterminate on purpose. Anthill reads
 * records; it cannot know how far along a step is, and a bar that filled would
 * be a measurement nobody made.
 */

import { ExplainerCard } from "./ExplainerCard.js";

export function WatchScene() {
  return (
    <div>
      <svg width="400" height="290" viewBox="0 0 400 290" aria-hidden="true">
        <defs>
          <marker
            id="ex-seen"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#2f8f5f" />
          </marker>
          <marker
            id="ex-idle"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#bab6b6" />
          </marker>
        </defs>
        <path
          d="M 164 82 L 206 82"
          stroke="#2f8f5f"
          strokeWidth="2.5"
          fill="none"
          markerEnd="url(#ex-seen)"
        />
        <path
          className="live-flow"
          d="M 285 134 L 285 164"
          stroke="#56aee0"
          strokeWidth="2"
          strokeDasharray="8 6"
          fill="none"
        />
        <path
          d="M 210 210 C 150 210, 82 206, 82 132"
          stroke="#e2dfdf"
          strokeWidth="1.75"
          fill="none"
          markerEnd="url(#ex-idle)"
        />
      </svg>

      <ExplainerCard
        at={{ left: 10, top: 40 }}
        dot="run-done"
        kicker="Agent Step"
        name="Implement"
        state="done"
        says="done · 1m 29s"
      />
      <ExplainerCard
        at={{ left: 210, top: 40 }}
        dot="run-work"
        dotPulses
        kicker="Run Tests"
        name="Run tests"
        state="working"
        says="working · 0:42"
      >
        <span className="ex-progress" aria-hidden="true">
          <i className="live-bar" />
        </span>
      </ExplainerCard>
      <ExplainerCard
        at={{ left: 210, top: 168 }}
        dot="run-idle"
        kicker="Agent Step"
        name="Fix failures"
        state="idle"
        says="not reached"
      />
    </div>
  );
}
