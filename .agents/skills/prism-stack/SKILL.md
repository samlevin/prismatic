---
name: prism-stack
description: "Build or adopt stacked Prismatic branches, stack on an unmerged prerequisite PR, link existing PRs into a native stack, cascade rebases, and sync after a merge with the gh stack extension. Run by the agent that created the delivery worktree, inside that worktree. Use when a Prismatic delivery in samlevin/prismatic splits a leaf into layers, builds on another issue's open PR, or must rebase a stack after a base moved or merged. Never creates PRs or merges."
---
<!-- Generated from .agents/workflows/stack.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# Prismatic stack

You run every command here yourself, in the worktree you created for the delivery, under the worktree rule in `AGENTS.md` (Autonomous delivery). No other agent runs it for you. Within the authority `AGENTS.md` gives a delivery request, this skill builds and pushes your own branches and links their existing PRs into a native stack. It never creates PRs (the delivery procedure opens them through REST), edits PR descriptions or bases, or deletes branches or stacks.

## Check the extension

Run `gh stack --help` before any other command here. If it exits non-zero, run `gh --version` and stop before any branch, stack, or PR work. In the main thread, give the install prompt from the Check gh stack section of the prism-implement skill. A prism-implementer returns `BLOCKED: gh stack not installed` with that version instead. Never install the extension yourself.

## Inspect before every change

1. `git fetch origin`. It updates only remote-tracking refs.
2. `git worktree list --porcelain`: note which worktree has each branch checked out.
3. For each branch: its local head, its remote head (`git ls-remote origin <branch>`), its intended parent (`origin/main`, the previous layer, or a prerequisite's pushed head), and whether that parent is an ancestor (`git merge-base --is-ancestor <parent> <branch>`).
4. `gh stack view --json`. Its state lives in the shared git directory, so it can list other worktrees' stacks; act only on yours.

You own a branch only while it is checked out in your worktree or in none, and only in one of two cases: you created it for this delivery with a name from `node scripts/branch-name.mjs`, or it is the head branch of the PR you rework or of the claim you resume and you verified its remote head before your first change. That verified head is the expected SHA for your first push. Trunk `main` and a prerequisite's branch are never yours.

Stop and report when any of these holds:

- A command could move the local trunk, a branch another worktree has checked out, or a branch you do not own. Name the branch and the worktree.
- Ownership is ambiguous, or a branch holds commits you did not make.
- A remote head differs from the head you last pushed or verified, so someone else pushed.
- A conflict needs a material decision.

## Operations

Every branch keeps its actual immediate base: `main` for layer 1, the previous layer, or the prerequisite's pushed head.

- Build: layer 1 is the branch the delivery procedure's worktree step created on the base SHA. Create each later layer on the one below it, bottom to top, with `git switch -c <layer n> <layer n-1>` and a name from `node scripts/branch-name.mjs <issue> --actor agent --layer <n>`. Track them with `gh stack init --base main <layer 1> ... <layer n>`. `init` adopts existing branches and creates missing ones, so verify the names first; a typo becomes a new branch. To grow a tracked stack, switch to its top layer and run `gh stack add <new layer>`. Commit with explicit paths yourself.
- Adopt: for branches you own, verify the names and ancestry, then run `gh stack init --base main <branches bottom to top>`.
- Prerequisite: base layer 1 on the prerequisite PR's pushed head SHA, which the delivery gate must allow, and record that SHA. Track only your own layers. Link the prerequisite's PR by URL.
- Cascade: after a layer changes, switch to the layer above it and run `gh stack rebase --no-trunk --upstack`. It rebases that layer and every layer above it onto their parents.
- Move the bottom layer: when its parent moved or merged (the trunk moved, the prerequisite was pushed again or merged, or a lower layer of yours merged), run `git -c rebase.updateRefs=false rebase --onto <new parent> <old parent head> <bottom layer>`, where the new parent is `origin/main` or the prerequisite's new pushed head, then cascade from the layer above it. This is the one rebase outside `gh stack`, because every `gh stack` command that rebases onto the trunk moves the local trunk first.
- Sync after a merge: move the lowest unmerged layer onto `origin/main` as above, with the merged branch's last head as the old parent. Then cascade, push, and link the remaining PRs again. Report any PR whose base still names the merged branch instead of changing it. Leave merged branches and the stack in place.
- Link: after the PRs exist, run `gh stack link --base main <PR URL> ...` bottom to top, prerequisite PRs first, with PR URLs only.
- Push: push each branch by itself, with `git push -u origin <branch>` the first time and `git push --force-with-lease=<branch>:<expected SHA> origin <branch>` afterwards. The expected SHA is the remote head you last pushed or verified. A rejection means someone else pushed: stop for that branch and report it. Report every remote head afterwards.
- Rework or resume a stacked branch: when no worktree has it checked out, check it out in your worktree with `git switch <branch>`, or `git switch --track -c <branch> origin/<branch>` when only the remote branch exists. Bring the local head to the verified remote head with `git merge --ff-only origin/<branch>` when it is behind, and stop when it has diverged. Then adopt, cascade, and push as above.

## Never run

- `gh stack rebase` without `--no-trunk`, or `gh stack sync`. Both fast-forward the local trunk, and `gh stack rebase` merges into whichever worktree has `main` checked out, the human checkout included.
- `gh stack push`. It refreshes the remote-tracking refs and then leases against them, so it overwrites another person's push.
- `gh stack submit`, or `gh stack link` with branch names. Both create PRs.
- `gh stack add` with `-A`, `-u`, or `-m`, or any blanket staging.
- `gh stack merge`, `gh stack unstack`, `--prune`, branch or stack deletion, `git pull` on trunk, and `git branch -f` or `git update-ref` on a branch you do not own.
- A `git rebase` without `-c rebase.updateRefs=false`. With `rebase.updateRefs` on, git moves every local branch that points into the rebased range, including branches you do not own.
- A bare `git push --force` or `git push --force-with-lease`. After a fetch, a bare lease checks the refreshed tracking ref and overwrites someone else's push.
- `gh pr edit --base`, or any other change to a PR base through the API.

## Conflicts

On a conflict, list the files with `git diff --name-only --diff-filter=U`. Resolve it yourself when the resolution is mechanical and inside the leaf's scope, then run `gh stack rebase --continue`, or `git rebase --continue` for the bottom-layer step. Otherwise run `gh stack rebase --abort` or `git rebase --abort`, which restores the branches, and stop with the conflicting files. Report any layer that was rebased before the conflict.

## Report

Report the stack id, the ordered branches and PRs, each branch's base and head SHAs before and after, the commands you ran, conflicts, every remote head, and which branches need validation again. A layer whose base or head moved before its PR opened also needs a new pre-PR review.
