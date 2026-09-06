import { join } from "node:path";

/** Keep the installed profile stable; development gets its own stores and lock. */
export function desktopUserDataPath(appData: string, isPackaged: boolean): string {
  return join(appData, "@anthill", isPackaged ? "desktop" : "desktop-dev");
}
