/**
 * Put an agent on a tier, in either agent editor (ANT-135).
 *
 * A tier is *applied*, not stored: pressing one writes that tier's model into
 * every tool slot it maps, and the agent file goes on saying exactly which
 * model it uses per tool. Which tier the agent is on is read back by
 * comparison, so a hand edit to one slot simply takes it off the tier.
 *
 * A tier that maps nothing is shown but cannot be pressed: applying it would
 * change nothing, and a button that silently does nothing is worse than one
 * that says why.
 */

import {
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  applyTier,
  tierOf,
  type AgentModels,
  type ModelPreferences,
} from "@anthill/workflow";

export function ModelTierBar({
  models,
  preferences,
  onChange,
}: {
  models: AgentModels | undefined;
  preferences: ModelPreferences;
  onChange: (models: AgentModels) => void;
}) {
  const current = tierOf(models, preferences);
  return (
    <div className="tier-bar" role="group" aria-label="Model tier">
      <span className="tier-bar-label">Tier</span>
      {MODEL_TIERS.map((tier) => {
        const mapped = Object.keys(preferences.tiers[tier]).length > 0;
        return (
          <button
            type="button"
            key={tier}
            className="tier-chip"
            aria-pressed={current === tier}
            disabled={!mapped}
            title={mapped ? MODEL_TIER_LABELS[tier].hint : "Map this tier to a model in Settings ▸ Models first."}
            onClick={() => onChange(applyTier(models, tier, preferences))}
          >
            {MODEL_TIER_LABELS[tier].label}
          </button>
        );
      })}
      <span className="tier-bar-note">{current ? "" : "Custom — chosen per tool"}</span>
    </div>
  );
}
