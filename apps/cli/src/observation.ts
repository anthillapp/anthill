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
    return { exitCode: 0, result: { outcome: "skipped", offer: false, message: "Use basic progress. Do not ask about detailed progress again unless the user asks, or until Anthill's hooks change." } };
  }
  // The session asking, when Codex says which. A hook of Anthill's that has
  // already fired in it settles the question without calling into Codex, which
  // an agent in Codex's sandbox cannot do (ANT-138).
  const sessionId = process.env.CODEX_SESSION_ID?.trim() || undefined;
  let status = await service.status(cwd, false, sessionId);
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
  const ask = harness?.observationPrompt ?? null;
  return { exitCode: 0, result: {
    // What to put to the user now, if anything: "connect", "trust", "hint".
    ask,
    // Kept for callers that read the older field.
    offer: ask === "connect",
    installed: harness?.hookInstalled ?? false,
    state: broken ? "broken" : harness?.codexHooks?.state ?? (harness?.cliAvailable ? "not-installed" : "unavailable"),
    confirmedInSession: harness?.codexHooks?.confirmedInSession ?? false,
    message: askMessage(ask, harness, broken),
    requiresHostAccess: harness?.codexHooks?.requiresHostAccess ?? false,
    lastEventAt: harness?.hookLastEventAt ?? null,
  } };
}

type Harness = NonNullable<Awaited<ReturnType<ObservationSetupService["status"]>>["harnesses"][number]>;

/** The sentence the agent relays, worded for what it is being asked to do. */
function askMessage(ask: string | null, harness: Harness | undefined, broken: boolean): string {
  // Broken is said as broken, whatever else is asked: a trusted entry whose
  // handler will not run is not a working hook.
  if (broken) {
    return `${harness?.hookProblem ?? "The Anthill hook handler could not run."} ${ask === "connect" ? "Ask: Connect to repair it, or Continue with basic progress." : "Basic progress remains available."}`;
  }
  if (ask === "connect") {
    return broken || harness?.hookEntriesPresent
      ? "Anthill's hooks need to be reconnected to this Anthill. They let Anthill show the agent's actions and detailed progress. Ask: Connect, or Continue with basic progress."
      : "Anthill's hooks are not connected. They let Anthill show the agent's actions and detailed progress; basic progress works without them. Ask: Connect, or Continue with basic progress.";
  }
  if (ask === "trust") {
    return "Codex has Anthill's hooks but has not approved them. Ask the user to type /hooks in Codex, choose Review hooks, and allow only the entries containing anthill-observation-hook. Do not suggest Trust all. Basic progress keeps working meanwhile.";
  }
  if (ask === "hint") {
    return `Anthill could not confirm the state of its hooks in Codex; that does not mean they are unapproved. ${harness?.codexHooks?.message ?? ""} Basic progress keeps working.`.replace(/\s+/g, " ").trim();
  }
  return harness?.codexHooks?.message ?? harness?.hookInstallProblem ?? "Basic progress works without detailed observation.";
}
