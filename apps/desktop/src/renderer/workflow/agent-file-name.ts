/**
 * Where an agent's file will be written, in the harness's own format.
 *
 * Two hints said `.md` whatever the harness, while the compiler wrote
 * `.codex/agents/*.toml` for Codex — the QA of ANT-51 found the two
 * disagreeing. The compiler's rule is the one that matters, and this is it.
 */

import { agentSlug, type AgentProfile, type HarnessProfile } from "@anthill/workflow";

export function agentFileExtension(harness: Pick<HarnessProfile, "agentFileFormat">): string {
  return harness.agentFileFormat === "toml" ? "toml" : "md";
}

export function agentFileName(
  harness: Pick<HarnessProfile, "agentDir" | "agentFileFormat">,
  profile: AgentProfile,
): string {
  return `${harness.agentDir ?? ""}/${agentSlug(profile)}.${agentFileExtension(harness)}`;
}
