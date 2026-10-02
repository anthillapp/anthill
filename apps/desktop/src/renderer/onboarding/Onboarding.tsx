/**
 * Onboarding — two pages, shown once, then the launch window (ANT-140).
 *
 * **Welcome** says what the product is for in one sentence and then shows it:
 * a pointer draws a real workflow on a real-looking canvas — the same block
 * anatomy, the same rework edge — so the benefit is seen before it is read.
 * With reduced motion it is the finished drawing, pointer at rest.
 *
 * **Connect** is optional, and says so first. It offers the plugin for each
 * tool with the same card From a session uses, reporting what is actually on
 * this Mac; nothing here is a gate, and Skip is always there. Once a tool is
 * really connected the way forward becomes Continue, but skipping still works.
 *
 * There is no third page. Finishing, from either page, lands on the launch
 * window, which for a new user holds one thing to do: create a first workflow.
 */

import { useEffect, useRef, useState } from "react";

import { AnthillMark } from "../AnthillMark.js";
import { interpreterLogo } from "../workflow/interpreter-logos.js";
import { PluginCard } from "../plugin/PluginCard.js";
import { readyTools } from "../plugin/plugin-card.js";
import { usePluginConnections, type Harness } from "../plugin/usePluginConnections.js";

export type OnboardingProps = {
  /** Finished or skipped, from either page. */
  onFinish: () => void;
  /** "Show the steps" on a card that cannot install from here. */
  onSettings: () => void;
};

/** Codex first, as the handoff lays them out. */
const TOOLS: { id: Harness; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "vscode", label: "VS Code" },
];

export function Onboarding({ onFinish, onSettings }: OnboardingProps) {
  const [page, setPage] = useState<1 | 2>(1);
  const heading = useRef<HTMLHeadingElement>(null);

  // A new page moves focus to its heading, so a keyboard or screen reader user
  // starts reading the page they just asked for rather than the button they left.
  useEffect(() => {
    heading.current?.focus();
  }, [page]);

  return (
    <div className="onboarding">
      {page === 1 ? (
        <Welcome heading={heading} onContinue={() => setPage(2)} />
      ) : (
        <Connect heading={heading} onBack={() => setPage(1)} onFinish={onFinish} onSettings={onSettings} />
      )}
      <div className="ob-dots" role="img" aria-label={`Step ${page} of 2`}>
        <i className={`ob-dot${page === 1 ? " is-current" : ""}`} />
        <i className={`ob-dot${page === 2 ? " is-current" : ""}`} />
      </div>
    </div>
  );
}

function Welcome({
  heading,
  onContinue,
}: {
  heading: React.RefObject<HTMLHeadingElement>;
  onContinue: () => void;
}) {
  return (
    <div className="ob-welcome">
      <div className="ob-welcome-copy">
        <AnthillMark size={48} className="ob-mark" />
        <h1 ref={heading} tabIndex={-1}>
          Welcome to Anthill
        </h1>
        <p className="ob-lede">See your workflows take shape, as clearly as if you sketched them on paper.</p>
        <p className="ob-sub">
          Steps, the agents who carry them out, and what happens when work is sent back – laid out
          where you can see them.
        </p>
        <button type="button" className="primary ob-continue" onClick={onContinue}>
          Continue
        </button>
      </div>
      <DrawingCanvas />
    </div>
  );
}

/**
 * A pointer draws Start → Implement → Run tests → Done, then the rework path:
 * Fix failures below Run tests, the amber edge down to it, and the edge back.
 *
 * One 9s loop with absolute percentages, so everything leaves together and the
 * next pass starts clean. Decorative — the copy beside it says what it shows.
 */
function DrawingCanvas() {
  return (
    <div className="ob-frame" aria-hidden="true">
      <div className="ob-canvas">
        <svg width="636" height="410" viewBox="0 0 636 410">
          <defs>
            <marker id="ob-ar" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#9b9797" />
            </marker>
            <marker id="ob-ar-rw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#d8a21a" />
            </marker>
          </defs>

          <path className="ob-e ob-e1" d="M 108 196 L 147 196" stroke="#9b9797" strokeWidth="1.7" fill="none" markerEnd="url(#ob-ar)" />
          <path className="ob-e ob-e2" d="M 301 196 L 359 196" stroke="#9b9797" strokeWidth="1.7" fill="none" markerEnd="url(#ob-ar)" />
          <path className="ob-e ob-e3" d="M 513 196 L 537 196" stroke="#9b9797" strokeWidth="1.7" fill="none" markerEnd="url(#ob-ar)" />
          <path className="ob-e4" d="M 437 233 L 437 289" stroke="#d8a21a" strokeWidth="1.7" fill="none" markerEnd="url(#ob-ar-rw)" />
          <path className="ob-e ob-e5" d="M 359 330 C 300 330, 226 322, 226 235" stroke="#9b9797" strokeWidth="1.7" fill="none" markerEnd="url(#ob-ar)" />

          <g>
            <rect x="20" y="180" width="88" height="32" rx="16" fill="#ffffff" stroke="#d7d3d3" />
            <circle cx="42" cy="196" r="3.5" fill="#605d5d" />
            <text x="54" y="201" className="ob-t" fontSize="12.5" fontWeight="600" fill="#444141">Start</text>
          </g>

          <Block className="ob-n-impl" x={150} y={160} dot="#6b5bd2" kicker="AGENT STEP" name="Implement" agent="Developer" agentWidth={64} />
          <Block className="ob-n-test" x={362} y={160} dot="#d8a21a" kicker="RUN TESTS" name="Run tests" agent="Tester" agentWidth={48} />
          <Block className="ob-n-fix" x={362} y={294} dot="#6b5bd2" kicker="AGENT STEP" name="Fix failures" agent="Developer" agentWidth={64} />

          <g>
            <rect x="540" y="180" width="80" height="32" rx="16" fill="#ffffff" stroke="#d7d3d3" />
            <circle cx="561" cy="196" r="3.5" fill="none" stroke="#bab6b6" strokeWidth="1.4" />
            <text x="573" y="201" className="ob-t" fontSize="12.5" fontWeight="600" fill="#444141">Done</text>
          </g>

          <g className="ob-chip">
            <rect x="448" y="249" width="78" height="22" rx="6" fill="#ffffff" stroke="#e0d6bb" />
            <text x="457" y="264" className="ob-t" fontSize="10.5" fontWeight="600" fill="#8a6a08">tests failed</text>
          </g>
        </svg>

        <div className="ob-ptr">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path
              d="M3 2 L3 19 L7.6 14.8 L10.6 21.4 L13.4 20.2 L10.5 13.8 L16.6 13.6 Z"
              fill="#201e1d"
              stroke="#ffffff"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

function Block({
  className,
  x,
  y,
  dot,
  kicker,
  name,
  agent,
  agentWidth,
}: {
  className: string;
  x: number;
  y: number;
  dot: string;
  kicker: string;
  name: string;
  agent: string;
  agentWidth: number;
}) {
  return (
    <g className={className}>
      <rect x={x} y={y} width="151" height="72" rx="10" fill="#ffffff" stroke="#d7d3d3" />
      <rect x={x + 12} y={y + 13} width="7" height="7" rx="2" fill={dot} />
      <text x={x + 25} y={y + 20} className="ob-t" fontSize="9.5" fontWeight="600" letterSpacing="0.8" fill="#8a8584">
        {kicker}
      </text>
      <text x={x + 12} y={y + 42} className="ob-t" fontSize="15" fontWeight="600" fill="#201e1d">
        {name}
      </text>
      <rect x={x + 12} y={y + 50} width={agentWidth} height="15" rx="7.5" fill="#f3f2f2" />
      <text x={x + 19} y={y + 61} className="ob-t" fontSize="9.5" fill="#605d5d">
        {agent}
      </text>
    </g>
  );
}

function Connect({
  heading,
  onBack,
  onFinish,
  onSettings,
}: {
  heading: React.RefObject<HTMLHeadingElement>;
  onBack: () => void;
  onFinish: () => void;
  onSettings: () => void;
}) {
  const plugins = usePluginConnections();
  const ready = readyTools(TOOLS.map((tool) => ({ label: tool.label, view: plugins.views[tool.id] })));

  return (
    <div className="ob-connect">
      <div className="ob-connect-inner">
        <span className="ob-kicker">Optional</span>
        <h1 ref={heading} tabIndex={-1}>
          Connect Codex, Claude Code or VS Code
        </h1>
        <p className="ob-connect-lede">
          Describe a task in Codex, Claude Code or VS Code, then review it here as a workflow. The plugin
          carries that handover – you can skip it and draw workflows yourself.
        </p>

        <div className="ob-path" aria-label="How the handover works" role="img">
          <span>
            <i style={{ backgroundImage: `url(${interpreterLogo("codex")})` }} />
            <i className="is-second" style={{ backgroundImage: `url(${interpreterLogo("claude-code")})` }} />
            Describe the task
          </span>
          <span className="arrow">→</span>
          <span>
            <AnthillMark size={16} />
            Review the workflow in Anthill
          </span>
        </div>

        <div className="ob-cards">
          {TOOLS.map((tool) => (
            <PluginCard
              key={tool.id}
              harness={tool.id}
              label={tool.label}
              view={plugins.views[tool.id]}
              onInstall={() => void plugins.install(tool.id)}
              onCheck={plugins.check}
              onGuide={() => plugins.guide(tool.id)}
              onSettings={onSettings}
            />
          ))}
        </div>

        <p className="ob-foot">
          Codex or Claude Code may ask you to confirm the install; VS Code takes it from its own
          settings. You can add any of them later from Settings ▸ Plugins.
        </p>

        <div className="ob-actions">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <span className="spacer" />
          {/* Skipping is always allowed. Once a tool is really connected the
              way forward is Continue, and Skip steps back to a quiet link. */}
          <button type="button" className={ready.length > 0 ? "ob-skip is-quiet" : "ob-skip"} onClick={onFinish}>
            Skip for now
          </button>
          {ready.length > 0 ? (
            <button type="button" className="primary ob-continue" onClick={onFinish}>
              Continue
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Onboarding;
