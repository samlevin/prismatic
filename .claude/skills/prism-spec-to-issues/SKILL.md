---
name: prism-spec-to-issues
description: "File a Prismatic specification's delivery plan as GitHub issues in samlevin/prismatic: one root container for the whole plan, one epic per phase under it, a container per stacked slice pair, and one leaf per slice, with section and Plan ID references rewritten to issue numbers, native sub-issues, blocked-by dependencies, and Prismatic delivery project Priority and Size. Builds and pre-flights the whole plan offline, prints the tree, and waits for confirmation; filing is paced and resumable. Use for 'file this spec as issues', 'turn the spec into epics', or 'resume the spec filing'. Does not implement or open PRs."
argument-hint: <path to specification> [dry run] [assignee <login>]
model: sonnet
effort: medium
---
<!-- Generated from .agents/workflows/spec-to-issues.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# Prismatic specification to issues

Files a specification written to `.agents/spec-slicing.md` as issues in `samlevin/prismatic`, in the project [Prismatic delivery](https://github.com/users/samlevin/projects/2) (number 2, owner `samlevin`). Read that guide first and follow it exactly; it defines the slice format, the ownership rules, and every pre-flight rule named below. This skill and the guide change together: a PR that changes one updates the other. `AGENTS.md` is already loaded. Repository commands run read-only against the checkout you were started in; never edit it.

References, read when the step needs them: [references/body-shapes.md](references/body-shapes.md) (bodies, reference rewriting, heading check), [references/state-file.md](references/state-file.md) (resumable state), [references/github-operations.md](references/github-operations.md) (REST calls, pacing, resume lookup). `fixtures/conforming-spec.md` and `fixtures/violating-spec.md` show a specification that files cleanly and one that fails pre-flight.

This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`). A `model` or `effort` override in the request applies to this turn by naming it (`/model`, `--model`, `--effort`), not through this skill.

## Authority

The request names the specification path. "Dry run", "plan", or "preview" means build, pre-flight, and print the tree, then stop with no GitHub writes. "File" or "create" authorizes creating the issues in the printed tree after the user confirms it, plus their sub-issue links, dependencies, independence records on the epics it files, project Priority and Size, and the two triage scripts. Nothing else: never edit `.github/labels.json`, create or rename labels, change repository or project settings, set project Status, or edit, link, or close any issue that this filing did not create. A missing label, field, option, or permission is a blocker to report, never something to create.

The assignee comes from the request, else from a local instruction file that sets a default assignee for filed issues (such as `CLAUDE.local.md` or `AGENTS.override.md`), else there is none. Metadata comes from the specification. prism-issue-triager runs only to form independence groups.

## 1. Build the plan offline

Make no GitHub call in this step or the next.

1. Read the specification. Find its `# ` title heading, the `Delivery plan` section, its definition-of-done and class-catalog fields, the phases with their Goal, Exit criteria, Contracts, and Deferred until fields, the heading slices with their fields, and the deferred-work tables, as the guide describes.
2. Number the items in creation order: the root container first, then epics in phase order, then one container per stack, then leaves in specification order. Key them `Plan`, `Phase <id>`, `Stack <stem>`, and the Plan ID. The root's sub-issues are every epic, deferred ones included, and nothing else.
3. Map every numbered section to its owner: a phase's Contracts sections to its epic, a slice's Owns sections to its leaf. A reference resolves to the owner of the section or of its nearest owned ancestor.
4. Assign class catalog rows to leaves by the files each slice's `Files` names, after brace expansion.
5. Render every body into the state directory's `bodies/` with `@@issue:KEY@@` placeholders, as body-shapes.md describes. Use a scratch directory with the same layout for a dry run and delete it afterwards.

## 2. Pre-flight

Check the rules in the order of the guide's rule table, against every item including the root: `reserved-text`, `plan-section`, `phase-format`, `slice-format`, `slice-unique`, `title-unique`, `blocked-by-resolves`, `acyclic`, `stack-shape`, `section-owner`, `section-reference`, `plan-id-reference`, `no-filler`, `label-exists` (against `.github/labels.json`), `body-size`, `template-headings`. Stop at the first rule that fails. Report each of its violations as `[rule] message`, naming the slice, phase, or section, and file nothing. Do not repair the specification yourself unless the user asks; a fix belongs in the specification.

## 3. Independence groups

Only the triager forms independence groups, by the definition in `.agents/independence-groups.md`. When at least one epic has two or more direct leaf children (layers of a stack container are its children, not the epic's), resolve the triager settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Spawn one `prism-issue-triager` for the plan with the resolved model and effort. Send only those leaves' drafts (Plan ID as ref, title, rendered body), each leaf's parent key and blocker keys, the reason `dependency judgment: independence groups only; metadata comes from the specification`, and the `Policy:` line (`Policy: tool=<tool> role=prism-issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`). Apply only its `GROUPS` lines and ignore its `EDGES` line, because the specification's `Blocked by` fields are the plan's only edges: record each epic's groups in `state.json` as state-file.md describes, and append the epic's independence record to `bodies/<epic>.md` with `@@issue:KEY@@` placeholders, as body-shapes.md describes, so every fill and patch in [File](#5-file) carries it. A dry run spawns it too, so the printed tree shows the groups. On resume, append the recorded groups to the rebuilt epic bodies the same way and never spawn the triager again.

Spawn with the Agent tool: `subagent_type: prism-issue-triager`, passing `model` and `effort` from the resolver explicitly.

## 4. Print the tree and stop

Print one line per item in tree order (the root first, then each epic under it followed by its children, with a container's layers under them), indented two spaces per level:

```text
#n   kind       Plan ID         size  priority  parent  blocked by        labels                                   title
```

`#n` is the predicted number when filing (the latest issue or pull request number plus the item's creation position, read as in github-operations.md) and the creation position written `(n)` in a dry run. The root holds position 1, so the first epic is position 2. Parent and blockers use the same notation. The root is kind `container` and counts in the container total. After the tree, print each epic's independence groups as Plan IDs, or `none`, then the totals per kind, the assignee or `none`, and the state directory. Then stop. A dry run ends here. A filing request waits for the user to confirm this tree; any change to the specification afterwards means building, checking, and printing again.

## 5. File

After confirmation, check the live repository before the first write: every label in the plan exists (`label-exists` again), the assignee is assignable, the project has Priority and Size fields with every option the plan uses, and you can read the project. Record the login. Then work through these stages in order, updating `state.json` after every write as state-file.md requires. Pace every write and handle rate limits as github-operations.md says.

1. Create. For each item without a number, in creation order: fill its body with actual numbers for items that exist and predictions for the rest, write it to `sent/`, and create the issue with its title, labels, and assignee. Prediction: the first item created in this run (the root on a fresh run) gets the latest number plus one; after each create, every later item's prediction is the number just returned plus its distance in creation order. Verify every create: when the returned number differs from the prediction, set `mismatch` and keep going with the new predictions. Before the first create, set `startedAt` to the current time minus 5 minutes, truncated to whole seconds, and write `state.json`, so an interruption during the first create can still be resumed.
2. Patch. If `mismatch` is set, or any item was created by an earlier run, refill every body with actual numbers. Patch each issue whose filled body differs from what was sent, and update `sent/` and `sentSha256`.
3. Link parents. For each item with a parent (every epic, stack container, and leaf; the root has none), add it as a sub-issue of its parent unless the parent's sub-issue list already holds it.
4. Link blockers. For each item with blockers, including a deferred epic and the leaves of its deferred table, add each blocker the issue's blocked-by list does not already hold.
5. Project fields. Handle the whole batch at once, never one issue at a time. After the last create, list the project's items once and match them to the created issues. If any are missing, wait one 3-minute window for the repository automation, re-listing every 10 seconds and stopping early once every issue has an item. Then add each issue still missing with the REST project add. Set Priority and Size on every item. Never set Status.
6. Scripts. Run `node scripts/issue-triage.mjs --apply --issue N` for each created issue, then `node scripts/issue-containers.mjs --apply --issue N` once for the root, whose subtree covers every epic, from the repository root. Stage 3 has linked every epic to the root by then. Pass `--issue` every time so the scripts touch only the issues this filing created.

## Resume

When `state.json` already exists for this specification, a request to file resumes it: check the recorded `spec` path and `specSha256` as state-file.md says, then rebuild the plan and confirm its `planSha256` matches, computed before the recorded groups are appended; a mismatch means the plan changed and needs a new confirmation. Before creating anything, run the resume lookup in github-operations.md and adopt every item that an interrupted run created, the root included. Then continue from the first unfinished stage; finished steps recorded in the state are not repeated, and every linking step checks GitHub before writing, so a rerun never duplicates an issue, link, or dependency.

## Verify and return

Read back a sample of bodies and every item's labels, parent, blockers, and project Priority, Size, and Status. Return the tree with actual numbers and URLs, each epic's independence groups, the triager's `Requested settings:` line verbatim when it ran, whether the patch pass ran and how many bodies it changed, the scripts' output lines, the state directory, and any unfinished item with what is missing (not on the project, no Status, no Priority or Size, a link that failed). An item the skill added to the project itself has no Status and `issue-triage.mjs` skips it; report it as needing a person to set Inbox. Say whether the run is complete or can resume.
