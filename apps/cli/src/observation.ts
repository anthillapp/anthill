import { observationRuntime } from "./observation-runtime.js";
import { ObservationSetupService } from "../../desktop/src/main/live/setup.js";

/** Plugin entry point. Consent happens in chat; hook trust stays inside Codex. */
export async function observationCommand(
  action: string | undefined,
  service = new ObservationSetupService(observationRuntime()),
  cwd = process.cwd(),
): Promise<{ exitCode: number; result: object }> {
  if (!["status", "enable", "skip"].includes(action ?? "")) {
    return { exitCode: 1, result: { error: "Usage: anthill observation status|enable|skip. Run from the project directory." } };
  }
  if (action === "skip") {
    await service.decline("codex");
    return { exitCode: 0, result: { outcome: "skipped", offer: false, message: "Use basic progress. Do not offer detailed progress again unless the user asks." } };
  }
  let status = await service.status(cwd);
  let harness = status.harnesses.find((harness) => harness.id === "codex");
  if (action === "enable" && !harness?.cliAvailable) {
    return { exitCode: 1, result: { error: "Codex CLI was not found. Basic progress remains available." } };
  }
  // Preserve an existing working desktop/CLI install and its trust hash.
  if (action === "enable" && (!harness?.hookInstalled || harness.hookUsesCurrentRuntime === false || harness.observationDeclined)) {
    const installed = await service.install("codex", cwd);
    if (!installed.ok) return { exitCode: 1, result: { error: installed.error, offer: false } };
    status = installed.status;
    harness = status.harnesses.find((harness) => harness.id === "codex");
  }
  const broken = Boolean(harness?.hookEntriesPresent && !harness.hookInstalled);
  return { exitCode: 0, result: {
    offer: Boolean(harness?.cliAvailable && !harness.hookInstallProblem && !harness.hookEntriesPresent && !harness.observationDeclined),
    installed: harness?.hookInstalled ?? false,
    state: broken ? "broken" : harness?.codexHooks?.state ?? (harness?.cliAvailable ? "not-installed" : "unavailable"),
    message: broken
      ? `${harness?.hookProblem ?? "The Anthill hook handler could not run."} Run anthill observation enable to repair it. Basic progress remains available.`
      : harness?.codexHooks?.message ?? harness?.hookInstallProblem ?? "Basic progress works without detailed observation.",
    requiresHostAccess: harness?.codexHooks?.requiresHostAccess ?? false,
    lastEventAt: harness?.hookLastEventAt ?? null,
  } };
}
