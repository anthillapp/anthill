import { realpathSync } from "node:fs";
import { defaultSpawn, type ChildProcessLike, type SpawnFn } from "@anthill/runtimes";
import type { CodexHookStatus } from "../../shared/ipc.js";

type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Inspect Codex itself. Never start a thread, run a hook, or change trust. */
export function readCodexHookStatus(options: {
  commands: { command: string; event: string }[];
  configPath: string;
  cwd: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}): Promise<CodexHookStatus> {
  return new Promise((resolve) => {
    let child: ChildProcessLike;
    let settled = false;
    let pending = "";
    let stderr = "";
    let bytes = 0;
    const results = new Map<number, RecordValue>();
    const timer = setTimeout(() => {
      finish(results.has(2)
        ? classifyCodexHooks(results.get(2)!, results.get(3) ?? {}, results.get(4) ?? {}, options)
        : { state: "unknown", message: "Codex did not answer the connection check. Basic progress is still available. Try checking again." });
    }, options.timeoutMs ?? 8_000);
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function finish(result: CodexHookStatus) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        try { child.stdin?.end(); child.kill("SIGTERM"); } catch { /* already closed */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already closed */ } }, 500);
        killTimer.unref();
      }
      resolve(result);
    }
    function fail(message: string) { finish({ state: "unknown", message }); }
    function send(message: object) {
      if (settled) return;
      try { child.stdin?.write(`${JSON.stringify(message)}\n`); }
      catch { fail("Could not communicate with Codex. Basic progress is still available."); }
    }
    function receive(message: RecordValue) {
      if (settled || ![1, 2, 3, 4].includes(message.id)) return;
      if (message.error && (message.id === 3 || message.id === 4)) {
        const method = message.id === 3 ? "config/read" : "configRequirements/read";
        results.set(message.id, { unavailable: method });
        if (results.size === 3) finish(classifyCodexHooks(results.get(2)!, results.get(3)!, results.get(4)!, options));
        return;
      }
      if (message.error) {
        fail(message.error.code === -32601
          ? "Codex does not support hooks/list. Update Codex, or inspect /hooks in Codex."
          : "Codex could not check hook permissions. Open /hooks in Codex to review the setup.");
        return;
      }
      if (!object(message.result)) { fail("Codex returned an unreadable connection status."); return; }
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "hooks/list", params: { cwds: [options.cwd] } });
        send({ id: 3, method: "config/read", params: { cwd: options.cwd, includeLayers: false } });
        send({ id: 4, method: "configRequirements/read", params: {} });
      } else {
        results.set(message.id, message.result);
        if (results.size === 3) finish(classifyCodexHooks(results.get(2)!, results.get(3)!, results.get(4)!, options));
      }
    }
    try {
      child = (options.spawnFn ?? defaultSpawn)("codex", ["app-server"], { cwd: options.cwd });
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { fail("Codex returned too much data to check hook permissions."); return; }
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          try { const message = JSON.parse(line); if (object(message)) receive(message); }
          catch { fail("Codex returned an unreadable connection status."); }
        }
      });
      child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 2048); });
      child.stdin?.on("error", () => fail("The connection to Codex closed before its permissions could be checked."));
      child.on("error", () => fail("Codex could not be started to check hook permissions."));
      child.on("close", () => {
        if (killTimer) clearTimeout(killTimer);
        const requiresHostAccess = /sqlite|permission denied|operation not permitted|read-only file system/i.test(stderr);
        finish({ state: "unknown", requiresHostAccess, message: requiresHostAccess
          ? "Codex could not access its local state. If this command ran in an agent sandbox, request host approval for this exact observation command and retry; do not change Codex hook trust."
          : "Codex closed before its hook permissions could be checked. Open /hooks in Codex to inspect them." });
      });
      send({ id: 1, method: "initialize", params: {
        clientInfo: { name: "anthill_observation", version: "1.0" },
        capabilities: { experimentalApi: true },
      } });
    } catch { fail("Codex could not be started to check hook permissions."); }
  });
}

export function classifyCodexHooks(
  listing: RecordValue, config: RecordValue, policy: RecordValue,
  expected: { commands: { command: string; event: string }[]; configPath: string; cwd: string },
): CodexHookStatus {
  const requirements = policy.requirements;
  const features = config.config?.features;
  const requiredFeatures = requirements?.featureRequirements;
  if (requirements?.allowManagedHooksOnly === true || (requiredFeatures?.hooks ?? requiredFeatures?.codex_hooks) === false) {
    return { state: "disabled", message: "Your Codex administrator has disabled user hooks. Basic progress remains available." };
  }
  if ((requiredFeatures?.hooks ?? requiredFeatures?.codex_hooks ?? features?.hooks ?? features?.codex_hooks) === false) {
    return { state: "disabled", message: "Hooks are turned off in Codex. Enable hooks in your Codex configuration to receive detailed progress." };
  }
  const entry = Array.isArray(listing.data) ? listing.data.find((row: any) => samePath(row?.cwd, expected.cwd)) : undefined;
  if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length > 0) {
    return { state: "unknown", message: "Codex could not load all hook settings. Open /hooks in Codex to inspect the configuration." };
  }
  const hooks = expected.commands.map(({ command, event }) => entry.hooks.find((hook: any) =>
    hook?.command === command && samePath(hook.sourcePath, expected.configPath) &&
    [event, event[0].toLowerCase() + event.slice(1)].includes(hook.eventName)));
  if (entry.hooks.some((hook: any) => expected.commands.some(({ command }) => hook?.command === command && samePath(hook.sourcePath, expected.configPath)) &&
      !expected.commands.some(({ event }) => [event, event[0].toLowerCase() + event.slice(1)].includes(hook.eventName)))) {
    return { state: "unknown", message: "Codex lists Anthill’s hooks with an unfamiliar event format. Review them in /hooks; basic progress remains available." };
  }
  if (!hooks.length || hooks.some((hook) => !hook)) {
    return { state: "not-loaded", message: "Codex has not loaded Anthill’s hooks from this configuration. Check /hooks in the Codex you use for this project." };
  }
  if (hooks.some((hook) => hook.enabled === false)) {
    return { state: "disabled", message: "Anthill hooks are disabled in Codex. Open /hooks and enable the Anthill entries." };
  }
  if (hooks.some((hook) => ["untrusted", "modified"].includes(hook.trustStatus))) {
    return { state: "needs-trust", message: "Open Codex, enter /hooks, and review and trust the entries containing anthill-observation-hook. Anthill will detect the change automatically." };
  }
  if (hooks.some((hook) => hook.enabled !== true || !["trusted", "managed"].includes(hook.trustStatus))) {
    return { state: "unknown", message: "Codex returned an unfamiliar permission state. Review Anthill’s entries in /hooks." };
  }
  if (!object(config.config) || !(policy.requirements === null || object(policy.requirements))) {
    const missing = [!object(config.config) && "config/read", !(policy.requirements === null || object(policy.requirements)) && "configRequirements/read"].filter(Boolean).join(" and ");
    return { state: "unknown", message: `Codex confirms Anthill’s hooks are trusted, but ${missing} could not verify global settings. Review /hooks; basic progress remains available.` };
  }
  return { state: "ready", message: "Codex has enabled and trusted Anthill’s hooks. Start a new Codex session to receive detailed progress." };
}

function samePath(actual: unknown, expected: string): boolean {
  if (actual === expected) return true;
  if (typeof actual !== "string") return false;
  try { return realpathSync(actual) === realpathSync(expected); }
  catch { return false; }
}
