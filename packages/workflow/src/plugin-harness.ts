/**
 * The coding tools Anthill ships a plugin for.
 *
 * A different list from the workflow targets in `./harness.ts`. A target is
 * what a diagram is written for — its models and agent files — and pi is one
 * with no plugin. A plugin harness is a tool that installs Anthill's plugin
 * from this repository, runs its MCP launcher and reports the hand-over.
 *
 * Everything that differs between them as data is here, once, for the app,
 * the MCP server and the launcher's `--host` to agree on. What differs as
 * behaviour — how each tool records an install, which commands change it —
 * is keyed by `PluginHarness` where it is done, so adding a tool to this
 * table is a compile error everywhere it still needs an answer.
 */

export const PLUGIN_HARNESSES = ["claude-code", "codex"] as const;

export type PluginHarness = (typeof PLUGIN_HARNESSES)[number];

export type PluginHarnessInfo = {
  id: PluginHarness;
  /** The tool's name, as a card or a sentence says it. */
  label: string;
  /** The command its CLI runs as. */
  cli: string;
  /** The plugin's folder in this repository. */
  folder: string;
  /** The plugin's manifest, relative to `folder`. */
  manifest: string;
  /** The plugin's name in that tool: `anthill` in every tool. */
  plugin: string;
  /** The marketplace this repository publishes the plugin under, for that tool. */
  marketplace: string;
  /** Whether the tool's CLI can switch a disabled plugin back on. */
  enablesFromCli: boolean;
  /** The page the tool's own makers keep for installing it. */
  installGuide: string;
};

export const PLUGIN_HARNESS_INFO: Record<PluginHarness, PluginHarnessInfo> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    cli: "claude",
    folder: "plugins/anthill-claude",
    manifest: ".claude-plugin/plugin.json",
    plugin: "anthill",
    marketplace: "anthill",
    enablesFromCli: true,
    installGuide: "https://code.claude.com/docs/en/setup",
  },
  codex: {
    id: "codex",
    label: "Codex",
    cli: "codex",
    folder: "plugins/anthill-codex",
    manifest: ".codex-plugin/plugin.json",
    plugin: "anthill",
    marketplace: "anthill-local",
    // Codex keeps the switch in its own settings.
    enablesFromCli: false,
    installGuide: "https://developers.openai.com/codex/cli",
  },
};

export function isPluginHarness(value: unknown): value is PluginHarness {
  return typeof value === "string" && (PLUGIN_HARNESSES as readonly string[]).includes(value);
}
