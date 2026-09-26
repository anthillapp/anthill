/**
 * What the CLI says about the platform it is running on (ANT-154).
 *
 * Windows is not supported yet, and it is not blocked either: the CLI runs,
 * says plainly that this is an experimental, unsupported build where some
 * commands or integrations may fail, points at where to report what does, and
 * carries on. A capability that cannot work there fails on its own, with its
 * own explanation — never the whole CLI because of the operating system.
 */

import { EXTERNAL_LINKS, PLATFORM_SCOPE } from "../../desktop/src/shared/links.js";

/** The warning for this platform, or nothing on a supported one. */
export function platformWarning(platform: NodeJS.Platform | string = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  return [
    "anthill: Windows is experimental and unsupported.",
    "  Windows support is coming soon. This build runs, but it has not been validated on Windows,",
    "  so some commands and integrations may fail. There is no compatibility, data-safety or support",
    "  guarantee. Carrying on anyway.",
    `  Report what does not work: ${EXTERNAL_LINKS.windowsIssue}`,
  ].join("\n");
}

/** The platform line `--help` prints, in the words every other surface uses. */
export const PLATFORM_HELP = `Platforms: ${PLATFORM_SCOPE}`;
