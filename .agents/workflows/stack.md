---
name: stack
description: "Build or adopt stacked {{label}} branches, stack on an unmerged prerequisite PR, link existing PRs into a native stack, cascade rebases, and sync after a merge with the gh stack extension, run by the agent that created the worktree. Use when a {{label}} delivery in {{repository}} splits a leaf into stacked layers, builds on another issue's open PR, or must rebase a stack after its base moved or merged. Never creates PRs or merges."
argument-hint: "<build|adopt|link|cascade|sync> [branches | PR URLs]"
codex:
  display_name: "{{label}}: Stack"
  short_description: "Build, link, rebase, and sync stacked {{label}} branches safely"
  default_prompt: "Use ${{prefix}}stack to manage the stacked branches for this {{label}} delivery."
---
# {{label}} stack

You run this skill yourself, in the worktree you created for the delivery, and you perform every command here. No other agent runs it for you, and you never run it in a worktree you did not create. Read `.agents/worktree-isolation.md` first if you have not yet.

Authority: the delivery request covers building your own branches, pushing them, and linking their existing PRs into a native stack. It never covers merges, auto-merge, creating PRs (the delivery procedure opens them through REST), editing PR descriptions, or deleting branches or stacks.

## Check the extension

Every operation here needs the `gh stack` extension (`github/gh-stack`), because each one starts with `gh stack view` and build, adopt, and link run `gh stack` commands. Before you build, adopt, link, cascade, or sync, run `gh stack --help >/dev/null`. A zero exit means the extension is installed; run the check once per delivery. A non-zero exit means it is missing, and you change nothing:

- In the main thread, stop and ask the person to run `! gh extension install github/gh-stack`. Installing an extension changes their workstation, so never run the install yourself. When they confirm, run the check again and continue only when it passes.
- An isolated {{prefix}}implementer returns `BLOCKED: gh stack not installed` with the output of `gh --version`. It keeps its claim, branch, and worktree, so the dispatcher can continue the same implementer after the install.

## Inspect before every mutation

1. Pass the [extension check](#check-the-extension). Use current verified prerequisite facts, refreshing remote refs with `git fetch origin` when they may have moved. This updates only remote-tracking refs, never a local branch. Reuse unchanged inspection results within the operation; ownership, remote heads, and ancestry must still be current before mutation.
2. `git worktree list --porcelain`: note which worktree has each branch checked out.
3. For each branch in the stack: its local head (`git rev-parse <branch>`), its remote head (`git ls-remote origin <branch>`), its intended parent (trunk `origin/main`, the previous layer, or a prerequisite's pushed head), and whether that parent is an ancestor (`git merge-base --is-ancestor <parent> <branch>`).
4. `gh stack view --json` for the tracked stack. Its state lives in the shared git directory, so it can list other worktrees' stacks; act only on yours.

You own a branch in two cases, and only while it is checked out in your worktree or in none:

- You created it for this delivery, with a name from `node scripts/branch-name.mjs`.
- It comes from an earlier delivery that you are reworking or resuming: `node scripts/branch-name.mjs` named it for this issue, it is the head branch of the target PR or of the claim you resume, and you verified its remote head before your first mutation. That verified head is the expected SHA for your first push.

Trunk `main` is never yours; it is usually checked out in the human checkout. Stop and report when any of these holds:

- A command could move a branch that another worktree has checked out, or a branch you do not own. Report that worktree's path or the branch.
- Ownership is ambiguous, or a branch holds commits you did not make.
- A remote head differs from the head you last pushed or verified, so someone else pushed.
- A conflict needs a material decision.

## Never run

- `gh stack sync` or `gh stack rebase`, with or without `--no-trunk`. Without `--no-trunk`, both fast-forward the local trunk branch, and `gh stack rebase` merges into whichever worktree has `main` checked out, the human checkout included. Cascade with plain git instead, as [Operations](#operations) shows, so every rebase carries `rebase.updateRefs=false`.
- `gh stack push`. It fetches before constructing its leases, so they compare against the fetched remote heads instead of the previously verified SHA and can overwrite someone else's push. Use the explicit per-branch leases in [Operations](#operations).
- `gh stack submit`, or `gh stack link` with anything but PR URLs. Both create PRs for branches that have none.
- `gh stack add` with `-A`, `-u`, or `-m`, or any blanket staging. Commit with explicit paths yourself.
- `gh stack unstack`, `--prune`, branch deletion, `git pull` on trunk, and `git branch -f` or `git update-ref` on any branch you do not own.
- A rebase without `-c rebase.updateRefs=false`. With `rebase.updateRefs` on, git moves every local branch that points into the rebased range and is not checked out elsewhere, including branches you do not own.
- A bare `git push --force` or `git push --force-with-lease`. After a fetch, a bare lease compares against the refreshed tracking ref and overwrites someone else's push.

## Operations

- Build: create the layers bottom to top: `git switch -c <layer 1> <base SHA>`, then `git switch -c <layer n> <layer n-1>` with names from `node scripts/branch-name.mjs <issue> --layer <n>`. Track them with `gh stack init --base main <layer 1> <layer 2> ...`. Create and verify the branches first: `init` adopts existing branches and creates missing ones, so a typo becomes a new branch. To grow a stack that is already tracked, switch to its top layer and run `gh stack add <layer n>` with a name that does not exist yet; it creates that branch on the top layer.{{#infrastructure}} Never add a layer that changes infrastructure the repository applies only from pull requests targeting `main` (Terrateam), unless no layer needs the apply before that layer is retargeted to `main`.{{/infrastructure}}
- Adopt: for branches you already own, verify names and ancestry, then `gh stack init --base main <branches bottom to top>`.
- Prerequisite: to build on another issue's unmerged PR, which the delivery gate must allow, base layer 1 on that PR's pushed head SHA and record the SHA. Never adopt, rebase, or push the prerequisite's branch; it belongs to another owner. Link its PR by URL instead.
- Link: after the PRs exist, run `gh stack link --base main <PR URL> ...` bottom to top, prerequisite PRs first, with PR URLs only.
- Cascade: after a lower layer changes, rebase each later layer onto its parent, bottom to top: `git -c rebase.updateRefs=false rebase --onto <new parent head> <old parent head> <layer>`. When the trunk moved, rebase layer 1 first with `git -c rebase.updateRefs=false rebase --onto origin/main <old base SHA> <layer 1>`. Every immediate base stays the actual parent: the trunk, the previous layer, or the prerequisite head.
- Sync after a merge: when layer k's PR merged, rebase layer k+1 with `git -c rebase.updateRefs=false rebase --onto origin/main <old layer k head> <layer k+1>`, then cascade the rest. Read the next PR's base with `gh api repos/{{repository}}/pulls/<n> --jq .base.ref`; when it still names the merged branch, set it with `gh api -X PATCH repos/{{repository}}/pulls/<n> -f base=main`, only on PRs you opened. Leave merged branches and the stack in place.
- Rework or resume: work on an earlier delivery's branch in one of two ways.
  - With the local branch checked out: when no worktree has it checked out, run `git worktree add <path> <branch>` if the local branch exists, or `git worktree add --track -b <branch> <path> origin/<branch>` if only the remote branch does. Make sure the local head equals the verified remote head; fast-forward with `git merge --ff-only origin/<branch>` when it is behind, and stop when it has diverged. The Cascade and Push commands in this list then work unchanged.
  - With a detached HEAD at `origin/<branch>`, as the rework path in the delivery procedure starts: run the cascade without naming a branch, `git -c rebase.updateRefs=false rebase --onto <new parent head> <old parent head>`, then push with `git push --force-with-lease=<branch>:<verified remote head> origin HEAD:<branch>`. Rebase and push one layer at a time, bottom to top, detaching at each next layer's `origin/<branch>` after the layer below is pushed.
- Push: push each branch on its own. Use `git push -u origin <branch>` for a first push, and afterwards `git push --force-with-lease=<branch>:<expected SHA> origin <branch>`, where the expected SHA is the remote head you last pushed or verified. A rejection means someone else pushed: stop for that branch and report it. Pushes are not atomic, so report every remote head afterwards.

## Conflicts

On a conflict, list the files with `git diff --name-only --diff-filter=U`. Resolve it yourself when the resolution is mechanical and inside the leaf's scope. Otherwise run `git rebase --abort`, which restores the branch, and stop with the conflicting files. Layers rebased before the conflict stay rebased; report them.

## Report

Report the stack id, the ordered branches and PRs, each branch's base and head SHAs before and after, the commands you ran, conflicts, and which branches need validation again. A layer whose base or head moved before its PR opened also needs a new pre-PR review.
