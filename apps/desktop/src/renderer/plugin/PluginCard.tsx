/**
 * One coding tool's plugin, as a card: the tool, where it stands, one line
 * about it, and the one thing to do next.
 *
 * Drawn the same on Onboarding and on From a session. Everything it says comes
 * from `plugin-card.ts`; this only lays it out. There is no "Plugin listing"
 * link: Anthill has no public listing to point at yet, and a link that opened
 * one would read as a way to install that nobody could follow.
 */

import { interpreterLogoBackground } from "../workflow/interpreter-logos.js";

import type { PluginCardView } from "./plugin-card.js";
import type { Harness } from "./usePluginConnections.js";

export type PluginCardProps = {
  harness: Harness;
  label: string;
  view: PluginCardView;
  onInstall: () => void;
  onCheck: () => void;
  onGuide: () => void;
  onSettings: () => void;
};

export function PluginCard({ harness, label, view, onInstall, onCheck, onGuide, onSettings }: PluginCardProps) {
  const busy = view.state === "installing";
  const run = {
    install: onInstall,
    check: onCheck,
    guide: onGuide,
    settings: onSettings,
  } as const;

  return (
    <div className={`plugin-card is-${view.state}`} role="group" aria-label={`${label} plugin`}>
      <div className="plugin-card-head">
        <i
          className="plugin-card-logo"
          aria-hidden="true"
          style={{ backgroundImage: interpreterLogoBackground(harness) }}
        />
        <span className="plugin-card-name">{label}</span>
        <span className={`plugin-badge is-${view.state}`} role="status">
          <i aria-hidden="true" />
          {view.badge}
        </span>
      </div>
      <p className="plugin-card-note">{view.note}</p>
      {view.detail ? <p className="plugin-card-detail">{view.detail}</p> : null}
      {view.action || busy ? (
        <div className="plugin-card-actions">
          {busy ? (
            <button type="button" className="plugin-card-btn is-busy" disabled aria-busy="true">
              <span className="plugin-spin" aria-hidden="true">
                ◌
              </span>
              Installing…
            </button>
          ) : view.action ? (
            <button
              type="button"
              className={`plugin-card-btn${view.action.outlined ? " is-outlined" : ""}`}
              onClick={run[view.action.kind]}
            >
              {view.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
