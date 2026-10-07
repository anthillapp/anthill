# Anthill: instructions for coding agents

Codex reads this file directly; Claude Code reads it through `CLAUDE.md`, which
imports it.

## Branches and releases

The process is described once, for people and agents alike, in
[RELEASING.md](RELEASING.md). Read it in full before you freeze a release,
open or update a pull request into master, make a hotfix, or check a
release candidate. If this list and RELEASING.md disagree, RELEASING.md is
right; fix this list.

Rules for every task:

- **master is the stable channel** (Linux and Windows build it from source;
  plugins installed from GitHub run it). Never base work on master and never
  open a pull request into master; only `stage` or a hotfix goes there, as
  RELEASING.md describes.
- **Work goes into `stage`.** Branch from `origin/stage`, open the pull request
  against it, merge with squash. Only what can ship goes in: `stage` is always
  green and releasable. A frozen `stage` (`npm run release -- status`) takes
  only fixes for what the release's checks found.
- **Never pick a version.** Before the freeze and before any pull request into
  master, ask the maintainer which version `stage` becomes, and wait for the
  answer.
- **Into master and back, merge commits only.** `stage` and hotfixes merge into
  master with a merge commit; after a hotfix, master is brought into `stage`
  with a merge commit too. Never squash those, and never rebase or force-push
  `stage`.
- **Do not merge into master** unless the maintainer asks for that specific
  merge: the merge publishes the release. The Release workflow tags the master
  commit and publishes the macOS build by itself; never push a `v*` tag.
- **A verification is about one commit**, named by its full SHA. Any change
  after it — a fix, a sync from master, a conflict resolution — is a new
  candidate and is checked again.
- **Report evidence per platform and per kind.** Building, automated tests and
  end-to-end use are different evidence; macOS results say nothing about Linux
  or Windows. End-to-end use is not a required step: when nobody ran it, say
  *not run*.
