/**
 * Scene 1 — three steps and the connections between them.
 *
 * The workflow the rest of the app uses as its example: implement, run tests,
 * and the rework path back when they fail. Each edge draws just after the card
 * it points at, so the sequence reads as "a step, then where it goes" rather
 * than as a diagram assembling at random.
 *
 * The amber dashed edge earns its place: rework is the one connection kind a
 * newcomer will not guess from the shape alone.
 */

import { ExplainerCard } from "./ExplainerCard.js";

export function DesignScene() {
  return (
    <div>
      <svg width="400" height="290" viewBox="0 0 400 290" aria-hidden="true">
        <defs>
          <marker
            id="ex-next"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#9b9797" />
          </marker>
          <marker
            id="ex-back"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#d8a21a" />
          </marker>
        </defs>
        <path
          className="ex-edge d1"
          d="M 164 82 L 206 82"
          stroke="#9b9797"
          strokeWidth="1.75"
          fill="none"
          markerEnd="url(#ex-next)"
        />
        <path
          className="ex-edge d2"
          d="M 285 134 L 285 164"
          stroke="#d8a21a"
          strokeWidth="1.75"
          strokeDasharray="7 5"
          fill="none"
          markerEnd="url(#ex-back)"
        />
        <path
          className="ex-edge d3"
          d="M 210 210 C 150 210, 82 206, 82 132"
          stroke="#9b9797"
          strokeWidth="1.75"
          fill="none"
          markerEnd="url(#ex-next)"
        />
      </svg>

      <ExplainerCard
        at={{ left: 10, top: 40 }}
        dot="cat-build"
        kicker="Agent Step"
        name="Implement"
        chip="Developer"
        enters="d1"
      />
      <ExplainerCard
        at={{ left: 210, top: 40 }}
        dot="cat-verify"
        kicker="Run Tests"
        name="Run tests"
        chip="Tester"
        enters="d2"
      />
      <ExplainerCard
        at={{ left: 210, top: 168 }}
        dot="cat-build"
        kicker="Agent Step"
        name="Fix failures"
        chip="Developer"
        enters="d3"
      />
    </div>
  );
}
