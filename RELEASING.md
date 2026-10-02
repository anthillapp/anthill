# Releasing Anthill

1. Set the version everywhere at once:

   ```bash
   npm run version:set -- 0.7.9
   npm install
   npm run plugin:bundle
   ```

   This writes every workspace `package.json`, the Claude Code plugin manifest
   and its marketplace entry, the Claude Code skill's frontmatter, the VS Code
   plugin manifest and its marketplace entry, and the Codex plugin manifest (with a fresh `+codex.<timestamp>` build suffix, which
   is what makes Codex treat a reinstall as new). `apps/mcp/src/versions.test.ts`
   fails if any of them disagree, so a version written by hand is caught.

   `npm run plugin:bundle` builds the MCP server and writes it, with this
   version in its first line, into `server/anthill-mcp.mjs` in every plugin.
   That copy is what a plugin installed from GitHub or a directory runs, so it
   is committed with the release. The same test fails when it is still last
   release's.

2. Open the release PR, squash-merge it, tag `v<version>`.

3. Refresh the installed plugins. A plugin installed from a directory is a
   copy, not a live mount — nothing refreshes it on its own (ANT-120):

   ```bash
   claude plugin update anthill@anthill
   ```

   and reinstall the Codex plugin from this checkout's marketplace. VS Code
   updates a plugin installed from a marketplace on its own schedule, as it
   does extensions, unless its auto-update is off. Then start new sessions: a
   running session keeps the skill it started with.

   If this step is skipped, the plugin's launcher reports the version it was
   installed at, and the MCP server puts a notice at the top of its
   instructions naming both versions and this command. That only works once
   the installed copy has a launcher new enough to report its version, i.e.
   from the first update after 0.7.8, and only when the plugin runs a
   checkout's server (`~/.anthill/plugin.json` or `ANTHILL_*`). A plugin
   running the server it carries is always the same version as that server,
   so it says nothing about being behind the app.

The plugin's version tracks the app's release: a plugin-only change ships with
a release, and every release asks installed plugins to update. That is a choice,
made so the two cannot drift apart by accident.
