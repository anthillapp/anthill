/**
 * The pages Anthill links out to. The renderer names a page, never an address:
 * main opens only what is listed here, so no page can ask it to open anything
 * else.
 */
export const EXTERNAL_LINKS = {
  source: "https://github.com/nstr/anthill",
  community: "https://www.reddit.com/r/AnthillApp/",
  website: "https://getanthill.ai/",
  support: "https://buymeacoffee.com/anthill",
  /** What diagnostics send and how to turn them off, in the public README (ANT-156). */
  privacy: "https://github.com/nstr/anthill#where-anthill-keeps-things",
  /** The Windows issue form: what an experimental Windows build reports through (ANT-154). */
  windowsIssue: "https://github.com/nstr/anthill/issues/new?template=windows.yml",
} as const;

/**
 * Where Anthill runs, in the words every surface uses — About, the README,
 * the CLI's warning and the release notes say the same thing (ANT-154).
 */
export const PLATFORM_SCOPE =
  "macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon – building from source is possible for experimentation, but Windows is not yet officially supported and some features may not work.";

export type ExternalLink = keyof typeof EXTERNAL_LINKS;

export function externalLink(name: unknown): string | undefined {
  return typeof name === "string" && Object.hasOwn(EXTERNAL_LINKS, name)
    ? EXTERNAL_LINKS[name as ExternalLink]
    : undefined;
}
