# Anthill

Anthill turns a coding task into a workflow you can see. You draw the steps, or
let your agent draft them: who does each one, and where work loops back. Then
you watch Claude Code, Codex, Pi or VS Code's agent carry it out, step by step,
on a live diagram.

Anthill plans and observes. It never runs, stops or steers an agent: the work
happens in your own CLI session, signed in as you.

Use it when a task is big enough to need a plan, such as a feature with review
and tests or a refactor shared between several agents, and you want to see
where the session actually is.

## Install

**macOS (Apple Silicon):** download the `.dmg` from
[Releases](https://github.com/anthillapp/anthill/releases), open it and drag Anthill
to Applications. After that, Anthill updates itself: it checks GitHub for a new
release, shows it under **Anthill → Check for Updates…** and in
**Settings → About**, and installs it when you choose **Download and Install**.
Turn the automatic check off on the same page.

**Linux:** Anthill runs as a local web app, built from source:

```bash
npm install && npm run build
npm install --global ./apps/cli
anthill            # opens Anthill on 127.0.0.1
```

**Windows (experimental):** there is no release or installer for Windows yet.
You can build Anthill from source to try it, the same way as on Linux, with
Node.js 22 and Git:

```powershell
git clone https://github.com/anthillapp/anthill.git
cd anthill
npm install
npm run build
npm install --global ./apps/cli
anthill            # opens Anthill on 127.0.0.1
```

It hasn't been validated on Windows yet, so some features, integrations and
local storage may not work, and there is no compatibility, data-safety or
support guarantee. Anthill says so once when it first starts, keeps an
*Unsupported Windows build* chip in view, and turns off anything known not to
work, saying why. If something breaks,
[report a Windows issue](https://github.com/anthillapp/anthill/issues/new?template=windows.yml).

macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon – building from source is possible for experimentation, but Windows is not yet officially supported and some features may not work.

You need at least one of [Claude Code](https://claude.com/claude-code),
[Codex](https://github.com/openai/codex), [Pi](https://pi.dev) or
[VS Code](https://code.visualstudio.com) with its agent, installed and signed
in.

## Plugins

The plugin lets your coding session hand its workflow to Anthill, so you don't
have to copy and paste a prompt. It is optional, but it is the recommended way.
It needs Node.js on your `PATH`.

**Claude Code:**

```bash
claude plugin marketplace add anthillapp/anthill
claude plugin install anthill@anthill
```

**Codex:**

```bash
codex plugin marketplace add anthillapp/anthill
codex plugin add anthill@anthill-local
```

Then start a new session.

**VS Code (beta):** VS Code has no command for plugins, but it opens two links that do the
install, each after you confirm it in VS Code: the first adds Anthill's
marketplace, the second installs the plugin from it.

macOS:

```bash
open "vscode://chat-plugin/add-marketplace?ref=anthillapp/anthill"
open "vscode://chat-plugin/install?source=anthillapp/anthill&plugin=anthill"
```

Windows (PowerShell):

```powershell
Start-Process "vscode://chat-plugin/add-marketplace?ref=anthillapp/anthill"
Start-Process "vscode://chat-plugin/install?source=anthillapp/anthill&plugin=anthill"
```

Linux: the same links with `xdg-open`.

Then start a new session in the Agents window (**New**: **⌘N** on macOS,
**Ctrl+N** on Windows and Linux) and try `/anthill:workflow watch <your task>`.
If you installed the plugin from `nstr/anthill` before the repository moved,
uninstall that one in **Customizations ▸ Plugins** first, or you will have two.

**By hand**, if the links do not open VS Code: first add Anthill's marketplace
to VS Code's settings, then install the plugin from that marketplace.

1. Open Settings (**⌘,** on macOS, **Ctrl+,** on Windows and Linux) and search
   for `chat.plugins.marketplaces`. Under **Chat › Plugins: Marketplaces**,
   choose **Add Item**, enter `anthillapp/anthill` and choose **OK**. The marketplace
   that is already there stays.

   Or in `settings.json` (**Preferences: Open User Settings (JSON)** in the
   Command Palette, **⇧⌘P** / **Ctrl+Shift+P**). The setting replaces VS
   Code's list, so keep its own marketplace in it:

   ```json
   "chat.plugins.marketplaces": ["github/awesome-copilot#marketplace", "anthillapp/anthill"]
   ```

2. Open the Agents window: run **Open Agents Window** from the Command
   Palette, or press **⇧⌥⌘A** on macOS, **Ctrl+Shift+Alt+A** on Windows and
   Linux.
3. Choose **Customizations** at the top left, then **Plugins**, then **Browse
   Marketplace** next to Available.
4. Type `anthill` in the search box, choose **Install** on **anthill**, then
   **Trust** when VS Code asks about `anthillapp/anthill`.
5. **Back to Installed** now lists anthill with "1 skill · 1 MCP server". Start
   a new session (**New**: **⌘N** on macOS, **Ctrl+N** on Windows and Linux)
   and try `/anthill:workflow watch <your task>`.

When VS Code asks for permission, allow Anthill's tools (`exchange: …`) with
**Allow in this Session**. For terminal commands, choose **Allow Once** from
the button's arrow menu: **Allow in this Session** on a terminal command offers
to auto-approve every command.

More in the [Claude Code](plugins/anthill-claude/README.md),
[Codex](plugins/anthill-codex/README.md) and [VS Code](plugins/anthill-vscode/README.md)
plugin guides.

Pi has no plugin. Copy the prompt from Anthill and paste it into Pi.

## Use

There are two modes. The difference is who owns the plan.

**design**: you shape the plan before any work starts. The agent asks what it
needs to know, drafts the workflow and stops. Edit it in Anthill, press
**Save**, and tell the session to go.

```text
/anthill:workflow design Add retry-once to the checkout flow     # Claude Code, VS Code
$anthill design Add retry-once to the checkout flow              # Codex
```

<img src="https://getanthill.ai/readme/anthill-design.svg" width="100%" alt="Design mode: the agent asks one question, drafts the workflow in Anthill and stops. You edit it, press Save, and tell the session to go.">

**watch**: the agent plans and starts at once, and Anthill shows the work as
it happens.

```text
/anthill:workflow watch Rework the importer                      # Claude Code, VS Code
$anthill watch Rework the importer                               # Codex
```

<img src="https://getanthill.ai/readme/anthill-watch.svg" width="100%" alt="Watch mode: the agent plans and starts at once, and Anthill shows each step as it happens.">

**run**: run a workflow you already have again, as often as you like. **Export**
in Anthill copies the command with the workflow's path in it, and each run is a
new session in Anthill.

```text
/anthill:workflow run "<path to workflow.json>"                  # Claude Code, VS Code
$anthill run "<path to workflow.json>"                           # Codex
```

Without a plugin, build the workflow in Anthill, press **Copy prompt**, and
paste it into your CLI. Anthill recognises the session and follows it the same
way.

## Principles

- **Local.** Workflows are plain `.workflow.json` files. Run data stays on
  your machine. There is no account and no sync.
- **No requests out, except diagnostics.** Anthill sends nothing anywhere
  except the anonymous diagnostics [below](#where-anthill-keeps-things), and
  you can turn those off. Your CLI talks to its own provider as usual; Anthill
  does not.
- **Read-only.** Anthill reads what your CLI already writes on disk and never
  sees private reasoning. In your project it writes only the agent files you
  hand over (`.claude/agents/`, `.codex/agents/`).
- **Instructions, not enforcement.** Order, conditions and loop limits are
  instructions for the agent. Anthill shows whether they were followed. It
  cannot force them.

<a id="where-anthill-keeps-things"></a>

## What leaves your machine

Three kinds of diagnostics. All three are on by default, and each can be turned
off in **Settings → Privacy**:

- **Anonymous usage analytics** (PostHog): a random app identifier and the
  names of a few actions, such as opening Anthill or saving a workflow. No
  prompts, workflow contents, paths or clicks.
- **Error reports** (Sentry): stack locations, with messages and user data
  removed. IP addresses are not stored.
- **Crash reports** (macOS, Sentry): a memory dump when the app crashes. It may
  contain data that was in memory at the time.

On macOS only release builds send diagnostics; the Linux CLI sends them too
unless you turn them off. The macOS app also asks GitHub for the newest release
when it opens and every few hours, a request for the public release list that
carries nothing about you or your workflows; turn it off in
**Settings → About**. Nothing else leaves your machine. Details are in
[CONTRIBUTING.md](CONTRIBUTING.md#where-anthill-keeps-things).

## Links

[Website](https://getanthill.ai) ·
[r/AnthillApp](https://www.reddit.com/r/AnthillApp/) ·
[Buy me a coffee](https://buymeacoffee.com/anthill) ·
[Report an issue](https://github.com/anthillapp/anthill/issues) ·
[Build from source and contribute](CONTRIBUTING.md)

MIT licensed. See [LICENSE](LICENSE).
