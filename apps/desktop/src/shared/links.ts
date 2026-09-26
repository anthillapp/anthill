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
} as const;

export type ExternalLink = keyof typeof EXTERNAL_LINKS;

export function externalLink(name: unknown): string | undefined {
  return typeof name === "string" && Object.hasOwn(EXTERNAL_LINKS, name)
    ? EXTERNAL_LINKS[name as ExternalLink]
    : undefined;
}
