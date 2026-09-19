import { isAbsolute, join, resolve } from "node:path";

/** Keep the installed profile stable; development gets its own stores and lock. */
export function desktopUserDataPath(appData: string, isPackaged: boolean): string {
  return join(appData, "@anthill", isPackaged ? "desktop" : "desktop-dev");
}

/** An explicit profile must agree with the MCP server's --data-dir. */
export function desktopDataDirectory(argv: readonly string[], fallback: string): string {
  let selected: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg !== "--data-dir" && !arg.startsWith("--data-dir=")) continue;
    if (selected !== undefined) throw new Error("--data-dir must be supplied only once.");
    selected = arg === "--data-dir" ? argv[++i] : arg.slice("--data-dir=".length);
    if (!selected?.trim() || !isAbsolute(selected)) throw new Error("--data-dir requires an absolute directory path.");
  }
  return selected ? resolve(selected) : fallback;
}
