# Anthill: instructions for coding agents

Codex reads this file directly; Claude Code reads it through `CLAUDE.md`, which
imports it. It is the one place the branch and release process is written down.
[RELEASING.md](RELEASING.md) holds only the mechanics it points to (setting the
version, the plugin bundle, refreshing installed plugins). If anything else
disagrees with this file, this file is right; fix the other one.

## Branches and releases

**master is the stable channel.** Linux and Windows users build Anthill from
source on master, and a plugin installed from GitHub runs the MCP server
committed there. macOS ships separately, as the disk image a `v<version>` tag
builds. So master receives only a release that passed its final QA, or a
hotfix, and the tag sits on exactly that master commit: every platform's
stable code is one release.

### Where work goes

- **The next-release branch** is `<V>-next`, where `<V>` is the version in
  master's `package.json` — the release it follows. It is not named after the
  release it will become, because whether that is a patch, a minor or a major
  is decided only when it is frozen. `npm run release -- status` prints it,
  whether it is open or frozen, and its tip. There is one at a time.
- **Every feature and fix branch starts from it** (`git switch -c <branch>
  origin/<V>-next`) and its pull request targets it. Merge with **squash**.
  Branch names carry the issue ID; the repository's other conventions are
  unchanged.
- **Never base work on master or open a pull request into master**, except the
  release itself or a hotfix, as described below. The required `release-gate`
  check fails anything else, and GitHub refuses a direct push to master.
- **It does not exist** (`status` says so): create it from master,
  `git push origin origin/master:refs/heads/<V>-next`. After a release this is
  done at once, so there is always a branch for new work.
- **Open or frozen.** The branch is *open* while its `package.json` still
  carries master's version, and *frozen* once the version bump has merged into
  it. A frozen branch takes only fixes for what this release's QA found, and
  release chores. A feature that misses the freeze waits as a draft pull request
  and moves to the next `-next` branch once that exists.

### Freeze and the release candidate

1. **Freeze** when the maintainer says the release's content is complete and
   has chosen its number X.Y.Z: a pull request `chore: release X.Y.Z` into
   `<V>-next` that sets the version and rebuilds the plugin bundle
   (RELEASING.md, step 1). The version, the bundle and the release notes are all
   done here, before the release goes anywhere near master.
2. **The release candidate is one commit**: the branch's tip after the freeze
   merged, named by its full 40-character SHA. Final QA verifies that commit
   and nothing else. Build the pre-release app from a clean checkout where
   `git rev-parse HEAD` prints that SHA.
3. **Automated checks** run by themselves on every push to the branch, on that
   exact commit: `check`, `linux-source`, `windows-source` (CI). For macOS
   packaging, also run the Release workflow by hand on the branch
   (`gh workflow run release.yml --ref <V>-next`): it builds the disk image and
   publishes nothing.
4. **Final QA** is the pre-release end-to-end pass on that commit, run with the
   maintainer's QA procedure.
5. **A bug found in QA** is fixed by a pull request into the branch. The new tip
   is a new candidate: the automated checks run again by themselves; rerun the
   failed scenario, every scenario touching the changed code, and the whole pass
   when the fix touches handover, observation, the plugins or the MCP server.
   Write down what was rerun and why.
6. **Anything that changes the branch after verification** — a fix, a hotfix
   brought in from master, a conflict resolution — makes a new candidate that
   is verified again before it can go to master. The gate enforces this: the
   commit named as verified must be the branch's head.

### What a check proves

Building, automated tests and end-to-end use are different evidence, and one
platform's result says nothing about another. A green macOS CI does not show
that Anthill builds or starts on Linux or Windows; a green `linux-source` does
not show that Anthill works on Linux.

| Evidence | macOS | Linux (supported: CLI) | Windows (experimental) |
| --- | --- | --- | --- |
| Builds | Release workflow by hand on the branch (disk image) | `linux-source`: README steps, `npm run build` | `windows-source`: the same |
| Automated tests | `check`: typecheck and tests on `macos-14` | `linux-source`: `npm test` | not run |
| Starts | final QA | `linux-source`: the CLI serves its page | `windows-source`: the same |
| End to end | final QA: desktop app with Codex and Claude Code | only on a real Linux machine | only on a real Windows machine |

Record every cell for the candidate as **passed**, **failed** or **not run**.
Never fill a cell from another one. macOS checks and final QA, and Linux
build, tests and start, must pass. A Windows failure does not block on its own,
but it is reported and the maintainer decides. A platform nobody used end to end
is reported as not verified end to end.

### Moving a release into master

1. Open one pull request from `<V>-next` into `master`, titled
   `chore: release X.Y.Z`. Its description has a line
   `` Verified commit: `<40-character SHA>` `` and the evidence table above.
   Public text only: no links to internal trackers or plans.
2. `release-gate` checks that the head is `<master's version>-next` or a hotfix
   branch of this repository, that its version is higher than master's, that
   the verified commit is the head, and that the squash will be exactly that
   commit's tree. When master holds changes the branch lacks, or they conflict,
   bring master into the branch (*Hotfixes*, step 5), verify the new candidate,
   and update the line. Never resolve conflicts in GitHub's editor, on master,
   or by editing the squash.
3. The maintainer squash-merges it. Agents do not merge into master or push
   tags unless the maintainer asks for that specific merge or tag.
4. Right after the merge, `npm run release -- landed <verified SHA>` checks that
   master is now that commit's tree and prints the tag command: `vX.Y.Z` on
   that master commit. Pushing the tag runs the Release workflow, which refuses
   a tag that is not on master or does not match the version, then builds and
   publishes the macOS disk image. The tag comes after the merge so that macOS
   never ships a release master does not have yet.
5. Refresh installed plugins (RELEASING.md, step 3).
6. Create `X.Y.Z-next` from the new master at once (*Where work goes*).
   Retarget every open pull request to it (`gh pr edit <n> --base X.Y.Z-next`)
   and rebase each branch onto it, dropping the old branch's commits, which
   the squash replaced on master:
   `git rebase --onto origin/X.Y.Z-next $(git merge-base HEAD <verified SHA>)`.

### Hotfixes

For a released version that cannot wait for the next release:

1. Branch `hotfix/<topic>` from `origin/master`. Commit the fix with its test,
   then set the version to the next patch after master's and rebuild the plugin
   bundle (RELEASING.md).
2. Verify the hotfix branch's tip like a candidate, scoped to the fix: the
   automated checks above, and end to end the flows the fix touches on macOS.
3. Pull request into master as in *Moving a release into master*, with its
   own `Verified commit:` line; the gate, the squash, `landed` and the tag are
   the same.
4. master's version has moved, so rename the next-release branch after it:
   `gh api -X POST repos/{owner}/{repo}/branches/<old V>-next/rename -f new_name=<new V>-next`
   (`status` prints this; GitHub retargets its open pull requests). If the
   branch was already frozen at the number the hotfix took, choose a higher
   one and freeze again.
5. Bring master into the next-release branch: branch `sync/<new V>` from it,
   `git merge origin/master`, keep the branch's own version where they conflict
   (rerun `npm run plugin:bundle` if it is frozen), and open a pull request into
   the branch that is merged with **Create a merge commit**, never squash. The
   merge commit is what lets the release later squash into master without
   conflicts. On a frozen branch this is a new candidate (step 6 above).
