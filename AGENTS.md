# Anthill: instructions for coding agents

Codex reads this file directly; Claude Code reads it through `CLAUDE.md`, which
imports it.

## Branches and releases

The process is described once, for people and agents alike, in
[RELEASING.md](RELEASING.md). Read it in full before you freeze a release,
open or update a pull request into master, tag, make a hotfix, or check a
release candidate. If this list and RELEASING.md disagree, RELEASING.md is
right; fix this list.

Rules for every task:

- **master is the stable channel** (Linux and Windows build it from source;
  plugins installed from GitHub run it). Never base work on master and never
  open a pull request into master; only the next-release branch or a hotfix
  goes there, as RELEASING.md describes.
- **Work goes into the next-release branch `<V>-next`**, where `<V>` is master's
  version (`0.8.8-next` while master is 0.8.8). Ask, do not guess:
  `npm run release -- status`. Branch from `origin/<V>-next`, open the pull
  request against it, merge with squash. A frozen branch takes only fixes for
  what the release's checks found.
- **Never pick a version.** Before the freeze and before any pull request into
  master, ask the maintainer which version `<V>-next` becomes, and wait for the
  answer. The pull request into master says it, e.g. `` `0.8.7-next` = 0.8.8 ``.
- **Do not merge into master or push tags** unless the maintainer asks for
  that specific merge or tag. The tag goes on the master commit right after the
  merge.
- **A verification is about one commit**, named by its full SHA. Any change
  after it — a fix, a sync from master, a conflict resolution — is a new
  candidate and is checked again.
- **Report evidence per platform and per kind.** Building, automated tests and
  end-to-end use are different evidence; macOS results say nothing about Linux
  or Windows. End-to-end use is not a required step: when nobody ran it, say
  *not run*.
