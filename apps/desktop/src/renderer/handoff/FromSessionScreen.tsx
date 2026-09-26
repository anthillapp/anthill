/**
 * "From a coding session" — how a Claude Code or Codex session hands a
 * workflow to Anthill.
 *
 * Two tabs, one per tool, and nothing for "any other tool": the raw handover
 * format is not something a person types, and offering it here made the
 * screen look like it was for somebody else. The tool is called "Codex"
 * everywhere, because that is what its app calls itself.
 *
 * Two steps, in the order they happen. **Install the plugin** is a real card
 * that says what this Mac has and runs the tool's own install when asked; it is
 * green only when the installed plugin's server answered. **Use Anthill** shows
 * one complete request, the task first and the command last, because that is
 * the order a person writes it in: they know what they want done before they
 * remember how to ask Anthill to show it.
 *
 * Anthill does not start, stop or steer the agent, and the screen says so in
 * its first paragraph rather than in a footnote.
 */

import { useState, type ReactNode } from "react";

import { AnthillMark } from "../AnthillMark.js";
import { interpreterLogo } from "../workflow/interpreter-logos.js";
import { PluginCard } from "../plugin/PluginCard.js";
import { HARNESSES, usePluginConnections, type Harness } from "../plugin/usePluginConnections.js";

export type FromSessionScreenProps = {
  onBack: () => void;
  onSettings: () => void;
};

type Surface = "app" | "terminal";

/** Everything that differs between the two tools, in one place. */
const TOOL: Record<
  Harness,
  {
    label: string;
    cli: string;
    welcome: string;
    /** The tool's own highlight colour in its composer. */
    accent: string;
    command: string;
    say: Record<Surface, string>;
    design: Record<Surface, string>;
    watch: Record<Surface, string>;
  }
> = {
  "claude-code": {
    label: "Claude Code",
    cli: "claude",
    welcome: "✻ Welcome to Claude Code · ~/dev/shop",
    accent: "#d97757",
    command: "/anthill:workflow",
    say: {
      app: "Describe the task, then end with /anthill:workflow design or watch.",
      terminal: "Start claude, describe the task, then end with /anthill:workflow design or watch.",
    },
    design: { app: "… /anthill:workflow design", terminal: "… /anthill:workflow design" },
    watch: { app: "… /anthill:workflow watch", terminal: "… /anthill:workflow watch" },
  },
  codex: {
    label: "Codex",
    cli: "codex",
    welcome: ">_ OpenAI Codex · ~/dev/shop",
    accent: "#9aa4ff",
    command: "$anthill",
    say: {
      app: "Describe the task, then type @, pick Anthill and add design or watch.",
      terminal: "Start codex, describe the task, then end with $anthill design or $anthill watch.",
    },
    design: { app: "… @Anthill design", terminal: "… $anthill design" },
    watch: { app: "… @Anthill watch", terminal: "… $anthill watch" },
  },
};

/** What happens once the workflow arrives. The same for both tools and both modes. */
const AFTER: { tone: string; text: string }[] = [
  { tone: "is-ok", text: "It appears under Sessions on the launch window the moment it is written." },
  {
    tone: "is-wait",
    text: "Open it and the toolbar says where it stands – waiting for you, saved, or already pinned by a run.",
  },
  {
    tone: "is-quiet",
    text: "If it is waiting, change what you want and press Save, then tell the session to go. Saving is a decision, not a start – the session picks it up when you tell it to.",
  },
  {
    tone: "is-quiet",
    text: "Once a run pins a revision, editing makes a new one and leaves the pinned revision alone.",
  },
];

const TASK = "Build a checkout flow, test it, and fix failures.";

export function FromSessionScreen({ onBack, onSettings }: FromSessionScreenProps) {
  const [tool, setTool] = useState<Harness>("claude-code");
  const [surface, setSurface] = useState<Surface>("app");
  const plugins = usePluginConnections();
  const t = TOOL[tool];

  return (
    <div className="from-session-screen">
      <div className="from-session-bar">
        <button type="button" className="icon-button on-dark" onClick={onBack} title="Back" aria-label="Back">
          ←
        </button>
        <AnthillMark size={18} />
        <span className="from-session-title">From a coding session</span>
      </div>

      <div className="from-session-body">
        <div className="from-session-inner">
          <div>
            <h1>Let a session hand you the workflow.</h1>
            <p className="from-session-lede">
              Ask Claude Code or Codex for the work as you normally would. Add Anthill to your prompt
              and it picks up the plan: review the workflow before work starts, or follow it live as
              your agent works.
            </p>
            <p className="from-session-note">
              Anthill displays and follows the work. It never starts, stops or steers your agent.
            </p>
          </div>

          <div className="from-session-tabs" role="group" aria-label="Coding tool">
            {HARNESSES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === tool}
                onClick={() => setTool(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <Section no="01" title="Install the plugin">
            One plugin works in both the {t.label} app and its terminal version. Install it once.
          </Section>
          <PluginCard
            harness={tool}
            label={t.label}
            view={plugins.views[tool]}
            onInstall={() => void plugins.install(tool)}
            onCheck={plugins.check}
            onGuide={() => plugins.guide(tool)}
            onSettings={onSettings}
          />

          <Section no="02" title={`Use Anthill in ${t.label}`}>
            Choose where you work. Each shows one complete request.
          </Section>

          <div className="from-session-surface">
            <div className="segmented" role="group" aria-label="Where you use it">
              <button type="button" aria-pressed={surface === "app"} onClick={() => setSurface("app")}>
                App
              </button>
              <button
                type="button"
                aria-pressed={surface === "terminal"}
                onClick={() => setSurface("terminal")}
              >
                Terminal
              </button>
            </div>
            <span>{t.say[surface]}</span>
          </div>

          {/* Keyed on the pair, so switching restarts the typing from the top. */}
          <Demo key={`${tool}-${surface}`} tool={tool} surface={surface} />

          <div className="from-session-modes">
            <div>
              <strong>Design</strong>
              <code>{t.design[surface]}</code>
              <span>
                Anthill shows the workflow and your agent waits. Review and change it on the canvas
                before work begins.
              </span>
            </div>
            <div>
              <strong>Watch</strong>
              <code>{t.watch[surface]}</code>
              <span>
                Your agent starts right away. Anthill shows the workflow and follows each step as it
                works.
              </span>
            </div>
          </div>

          <div className="from-session-after">
            <span className="from-session-kicker">Then, in Anthill</span>
            <ul>
              {AFTER.map((item) => (
                <li key={item.text}>
                  <i className={item.tone} aria-hidden="true" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="from-session-foot">
            Anthill reads the workflow the session wrote and the records it leaves on this machine. It
            does not read your project, and it sends nothing anywhere.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ no, title, children }: { no: string; title: string; children: ReactNode }) {
  return (
    <>
      <div className="from-session-step">
        <span className="no">{no}</span>
        <h2>{title}</h2>
        <i aria-hidden="true" />
      </div>
      <p className="from-session-step-lede">{children}</p>
    </>
  );
}

/**
 * One complete request, typed out: the task, then the command.
 *
 * Decorative, so hidden from assistive tech — the line above it says the same
 * thing in words. With reduced motion it shows the finished request.
 */
function Demo({ tool, surface }: { tool: Harness; surface: Surface }) {
  const t = TOOL[tool];
  const accent = { color: t.accent };
  const command = (
    <span
      className="fs-cut fs-tb"
      style={{ ...accent, fontWeight: 600, ["--n" as string]: `${t.command.length + 0.2}ch`, animationTimingFunction: `steps(${t.command.length}, end)` }}
    >
      {t.command}
    </span>
  );
  const task = (
    <span className="fs-cut fs-ta" style={{ ["--n" as string]: "49.2ch", animationTimingFunction: "steps(49, end)" }}>
      {TASK}
    </span>
  );
  const rest = (
    <>
      <span className="fs-cut fs-tc" style={{ ["--n" as string]: "16.2ch", animationTimingFunction: "steps(16, end)" }}>
        &nbsp;design workflow
      </span>
      <span className="fs-caret">▍</span>
    </>
  );

  return (
    <div className="fs-demo fs-whole" aria-hidden="true">
      <div className="fs-demo-head">
        <i style={{ backgroundImage: `url(${interpreterLogo(tool)})` }} />
        <span>{surface === "terminal" ? "Terminal" : `${t.label} app`}</span>
        <span className="spacer" />
        <span className="fs-demo-meta">{surface === "terminal" ? "zsh" : "your session"}</span>
      </div>

      {surface === "terminal" ? (
        <div className="fs-demo-term">
          <div className="fs-pre">
            <span className="dim">~/dev/shop $&nbsp;</span>
            {t.cli}
          </div>
          <div className="fs-pre2" style={accent}>
            {t.welcome}
          </div>
          <div className="line" style={{ marginTop: 4 }}>
            <span className="dim">&gt;&nbsp;</span>
            {task}
          </div>
          <div className="line">
            <span style={{ visibility: "hidden" }}>&gt;&nbsp;</span>
            {command}
            {rest}
          </div>
        </div>
      ) : tool === "codex" ? (
        <>
          <div className="fs-demo-composer">
            <div className="line">{task}</div>
            <div className="line">
              <span className="fs-cut fs-cq" style={{ color: "#f0775f" }}>
                @A
              </span>
              <span className="fs-cut fs-cchip fs-demo-chip">
                <span className="fs-demo-chip-mark">
                  <AnthillMark size={12} />
                </span>
                Anthill
              </span>
              {rest}
            </div>
          </div>
          <div className="fs-cmenu fs-demo-menu">
            <div>
              <span className="fs-demo-chip-mark is-large">
                <AnthillMark size={14} />
              </span>
              <strong>Anthill</strong>
              <span>Design a workflow and follow its progress</span>
            </div>
          </div>
        </>
      ) : (
        <div className="fs-demo-composer is-claude">
          <div className="line">{task}</div>
          <div className="line">
            {command}
            {rest}
          </div>
        </div>
      )}

      <div className="fs-result fs-demo-result">
        <AnthillMark size={18} />
        <span>
          Anthill received <b>Checkout flow</b> – 5 steps, 2 agents. Review it before work starts.
        </span>
        <span className="fs-demo-review">Review</span>
      </div>
    </div>
  );
}

export default FromSessionScreen;
