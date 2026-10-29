---
name: spec-to-issues
description: "File a Prismatic specification's delivery plan as GitHub issues in samlevin/prismatic: one root container for the whole plan, one epic per phase under it, a container per stacked slice pair, and one leaf per slice, linked as native sub-issues with blocked-by dependencies and Prismatic delivery project Priority and Size. Runs `agenticool-spec` to pre-flight the plan offline, records the triager's independence groups, prints the plan, and waits for confirmation; filing is paced and resumable. Use for 'file this spec as issues', 'turn the spec into epics', or 'resume the spec filing'. Does not implement or open PRs."
argument-hint: <path to specification> [dry run] [assignee <login>]
model: sonnet
effort: medium
---
<!-- Generated from @agenticool/agents/sources/workflows/spec-to-issues.md by agenticool-agents. Edit the source and run `npx agenticool-agents generate`. -->

# Prismatic specification to issues

Files a specification written to the spec-slicing format as issues in `samlevin/prismatic`, in the project [Prismatic delivery](https://github.com/users/samlevin/projects/2) (number 2, owner `samlevin`). `npx agenticool-spec` from `@agenticool/spec`, installed in the repository, does every deterministic step: it parses the specification, applies the pre-flight rules, renders every body, and records, confirms, files, and resumes the plan. This skill applies no rule and writes no issue body itself: it runs those commands, asks the triager for independence groups, and relays the output. `AGENTS.md` is already loaded. Repository commands run read-only against the checkout you were started in; never edit it.

The format, the ownership rules, and every pre-flight rule are in `node_modules/@agenticool/spec/spec-slicing.md`; read it when the user asks why a rule failed or how to fix the specification. The commands, the confirmation digest, and the filing stages are described in `node_modules/@agenticool/spec/README.md`. `node_modules/@agenticool/spec/fixtures/conforming-spec.md` and `fixtures/violating-spec.md` show a specification that files cleanly and one that fails pre-flight.

This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`). A `model` or `effort` override in the request applies to this turn by naming it (`/model`, `--model`, `--effort`), not through this skill.

## Authority

The request names the specification path. "Dry run", "plan", or "preview" means pre-flight, triage, and print the plan, then stop with no GitHub writes. "File" or "create" authorizes running `confirm` and `file` after the user confirms the printed plan, and with them every write `file` makes: the issues, their sub-issue links, dependencies, independence records, project Priority and Size, and the triage and container runs. Nothing else: never edit `.github/labels.json`, create or rename labels, change repository or project settings, set project Status, or edit, link, or close any issue that this filing did not create. A missing label, field, option, or permission is a blocker to report, never something to create. Never run `confirm` before the user confirms.

The assignee comes from the request, else from a local instruction file that sets a default assignee for filed issues (such as `CLAUDE.local.md` or `AGENTS.override.md`), else there is none. Metadata comes from the specification. issue-triager runs only to form independence groups.

The state directory is `${XDG_STATE_HOME:-$HOME/.local/state}/spec-to-issues/<owner>-<repo>-<spec file name without .md>-<path hash>/`, where `<path hash>` is the first 8 hex characters of the SHA-256 of the specification's absolute path (`printf '%s' /abs/spec.md | shasum -a 256 | cut -c1-8`), as `node_modules/@agenticool/spec/state-file.md` defines it. Run every command from the repository root.

## 1. Pre-flight

Run `npx agenticool-spec plan <spec>`. It makes no GitHub call. When it exits non-zero, report its `[rule] message` lines exactly as printed and stop; file nothing. Do not repair the specification yourself unless the user asks; a fix belongs in the specification. When it exits 0, keep the printed tree for the next step.

## 2. Independence groups

Only the triager forms independence groups, by the definition in `.agents/independence-groups.md`. It groups the whole plan at once, so leaves of different phase epics can be delivered in parallel. Skip this step when the tree has fewer than two leaves.

Otherwise create a scratch directory outside the repository (`mktemp -d`) and run `npx agenticool-spec plan <spec> --bodies <scratch>/bodies --json <scratch>/plan.json`, which writes each rendered body to `<scratch>/bodies/<KEY>.md` and the parsed plan, with each item's `key`, `parent`, and `blockedBy`, to `plan.json`. Resolve the triager settings with `npx agenticool-agents resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Spawn one `issue-triager` for the plan with the resolved model and effort. Send only the drafts of every leaf in the plan, stack layers included (Plan ID as ref, title, and the rendered body from `<scratch>/bodies/<Plan ID>.md`), each leaf's parent key and blocker keys from `plan.json`, the reason `dependency judgment: plan-wide independence groups only, container ref Plan; metadata comes from the specification`, and the `Policy:` line (`Policy: tool=<tool> role=issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`).

Spawn with the Agent tool: `subagent_type: issue-triager`, passing `model` and `effort` from the resolver explicitly.

Apply only its `Plan | GROUPS` line and ignore its `EDGES` line, because the specification's `Blocked by` fields are the plan's only edges. Unless that line reads `none`, write the groups to `<scratch>/groups.json` under the key `Plan`, one list of Plan IDs per group, leaving out ungrouped leaves. A group may hold leaves of different epics:

```json
{ "Plan": [["P0.1", "P1.2"], ["P0.2", "P2.1"]] }
```

`file` appends them to the root container's body as the plan-wide record `.agents/independence-groups.md` describes.

## 3. Print the plan and wait

Run `npx agenticool-spec plan <spec> --state <dir> [--groups <scratch>/groups.json] [--assignee <login>]`, passing `--groups` only when step 2 wrote the file and `--assignee` only when there is one. Print its output in full: the tree, the plan-wide and each epic's groups, the totals, the assignee, the state directory, and the `Plan digest:` line. Delete the scratch directory. A dry run ends here. A filing request waits for the user to confirm this output; any change to the specification afterwards means running steps 1 to 3 again.

## 4. File

After the user confirms, run `npx agenticool-spec confirm <digest> --state <dir>` with the digest from the printed `Plan digest:` line, then `npx agenticool-spec file <spec> --state <dir>`. Print the output as it arrives. When either command exits non-zero, report its message and stop; when the message names a resume command, the filing can resume.

## Resume

A request to resume, or to file a specification whose state directory already holds `state.json`, runs `npx agenticool-spec resume <spec> --state <dir>`. It reuses the groups and assignee recorded in the state, so never spawn the triager again. When it refuses because the specification or the plan changed, report its message and stop: filing a changed specification after filing began needs a person's decision, because the filed issues stay and a new filing needs a new state directory.

## Verify and return

Read back a sample of the filed bodies and every item's labels, parent, blockers, and project Priority, Size, and Status. Return the issue lines `file` or `resume` printed (key, number, title, URL), the plan-wide independence groups, the triager's `Requested settings:` line verbatim when it ran, the patch pass line when it ran, the state directory, and any unfinished item with what is missing (not on the project, no Status, no Priority or Size, a link that failed). Say whether the run is complete or can resume.
