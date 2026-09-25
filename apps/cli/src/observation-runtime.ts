import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedObservationRuntime } from "../../desktop/src/main/live/installed-runtime.js";
import type { ObservationSetupPaths } from "../../desktop/src/main/live/setup.js";

/** Persistent hooks use the installed app's interpreter, never nvm or this checkout. */
export function observationRuntime(
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
): ObservationSetupPaths {
  const installed = installedObservationRuntime(platform, home, exists);
  if (installed) return installed;
  return {
    // Read existing configuration even when the persistent runtime is unavailable.
    hookHandlerPath: join(dirname(fileURLToPath(import.meta.url)), "../../desktop/src/main/live/hook-handler.js"),
    installProblem: "A supported installed Anthill desktop app is required for durable hooks. Install Anthill in Applications, then connect detailed progress again. Basic progress remains available.",
  };
}
