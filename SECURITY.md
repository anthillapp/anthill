# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:
open the repository's **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/nstr/anthill/security/advisories/new)).

Include what you found, how to reproduce it, and the Anthill version
(**Settings → About**). Anthill is maintained by one person, so there is no
guaranteed response time, but every report is read.

## Supported versions

Only the latest release gets security fixes. Update before reporting, in case
it is already fixed.

## What is in scope

- The macOS desktop app and the Linux CLI (`apps/desktop`, `apps/cli`)
- The local MCP server and the Claude Code and Codex plugins (`apps/mcp`,
  `plugins/`)
- What Anthill writes on your machine: hook entries in your CLIs' configs,
  agent files in your project, and its own data folders

Anthill does not run agents, so how Claude Code, Codex or Pi behave is out of
scope; report that to their makers. What Anthill sends off the machine is
listed in the [README](README.md#where-anthill-keeps-things); anything sent
beyond that is a bug worth reporting.
