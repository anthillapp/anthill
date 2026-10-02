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

export const PLUGIN_HARNESSES = ["claude-code", "codex", "vscode"] as const;

export type PluginHarness = (typeof PLUGIN_HARNESSES)[number];

/**
 * The plugin harnesses Anthill reads the install records of: a card each in
 * Settings ▸ Plugins and in onboarding. Every plugin harness today; kept
 * apart so that a plugin can ship before Anthill can say where it stands.
 */
export const CHECKED_PLUGIN_HARNESSES = ["claude-code", "codex", "vscode"] as const satisfies readonly PluginHarness[];

export type CheckedPluginHarness = (typeof CHECKED_PLUGIN_HARNESSES)[number];

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
  /**
   * Whether Anthill can install the plugin by running the tool's own
   * commands. Without them, the card shows the steps instead.
   */
  installsFromAnthill: boolean;
  /** The page the tool's own makers keep for installing it. */
  installGuide: string;
  /**
   * Shipped as a beta: it works end to end, with gaps its README names.
   * Every surface that names the plugin says so.
   */
  beta: boolean;
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
    installsFromAnthill: true,
    installGuide: "https://code.claude.com/docs/en/setup",
    beta: false,
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
    installsFromAnthill: true,
    installGuide: "https://developers.openai.com/codex/cli",
    beta: false,
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    cli: "code",
    folder: "plugins/anthill-vscode",
    // VS Code's own plugin format: a manifest at the root, and no `$schema`,
    // which would make it the stricter format that expands no plugin root.
    manifest: "plugin.json",
    plugin: "anthill",
    // The name `.github/plugin/marketplace.json` gives itself. VS Code reads
    // that file before `.claude-plugin/marketplace.json`; Claude Code never
    // reads it, so the two plugins named `anthill` do not collide.
    marketplace: "anthill",
    // VS Code has no command line for plugins at all: both ways in are its
    // settings, which are the user's to edit.
    enablesFromCli: false,
    installsFromAnthill: false,
    installGuide: "https://code.visualstudio.com/download",
    // Tool calls reach Anthill from VS Code's session record, not its hooks,
    // and the plugin is installed from VS Code's settings, not from Anthill.
    beta: true,
  },
};

export function isPluginHarness(value: unknown): value is PluginHarness {
  return typeof value === "string" && (PLUGIN_HARNESSES as readonly string[]).includes(value);
}

export function isCheckedPluginHarness(value: unknown): value is CheckedPluginHarness {
  return typeof value === "string" && (CHECKED_PLUGIN_HARNESSES as readonly string[]).includes(value);
}
