import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Known installation locations only: never run a path taken from hook configuration. */
export function installedObservationRuntime(
  platform = process.platform, home = homedir(), exists = existsSync,
): { execPath: string; hookHandlerPath: string } | undefined {
  if (platform !== "darwin") return undefined;
  for (const app of ["/Applications/Anthill.app", join(home, "Applications/Anthill.app")]) {
    const execPath = join(app, "Contents/MacOS/Anthill");
    const archive = join(app, "Contents/Resources/app.asar");
    if (exists(execPath) && exists(archive)) return {
      execPath, hookHandlerPath: join(archive, "out/main/live-hook-handler.js"),
    };
  }
  return undefined;
}
