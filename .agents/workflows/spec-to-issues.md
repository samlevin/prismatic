---
name: spec-to-issues
description: Build, validate, triage, and file a specification's §20 delivery plan as a resumable tree of {{label}} issues. Use for a spec path with plan, dry run, file, or resume. Filing requires confirmation of the printed tree. Does not write or review the spec, implement issues, or open PRs.
argument-hint: "<spec-path> [plan|dry run|file|resume] [state-path] [triager model <name>] [triager effort <level>]"
capability: issue-creation
codex:
  display_name: "{{label}}: Spec to issues"
  short_description: "Validate and file a spec delivery plan"
  default_prompt: "Use ${{prefix}}spec-to-issues to plan issues from this specification."
---
# {{label}} spec to issues

## Resolve

Accept one repository spec path and a mode. Default to `plan`; `dry run` means the same. Writing or reviewing a spec never authorizes filing it. A `file` request authorizes preparation, then requires the person's confirmation of the printed tree before any GitHub write. A `resume` request continues only the same confirmed plan from its state file. Bind to repository `{{repository}}`, project {{project.number}} owned by `{{project.owner}}`. Use REST through `gh api` only for your GitHub calls, including reads. Repository scripts retain their own transport.

Read `specs/TEMPLATE.md` §20, `.agents/issue-creation.md`, and the supplied spec. Load {{prefix}}plain-language before drafting bodies. Use [references/body-formats.md](references/body-formats.md) when building drafts, [references/state.md](references/state.md) when loading or saving a run, and [references/github-operations.md](references/github-operations.md) only when filing. No worktree or repository edit is needed to run this skill. Keep drafts, state, and command payloads outside the repository, including outside the human checkout and every linked worktree.

<!-- codex-only -->
Resolve `node scripts/agent-policy.mjs resolve --tool codex --capability issue-creation` and state `Advisory policy: tool=codex capability=issue-creation model=<model> effort=<effort> (session settings apply)`. The skill cannot change the session settings.
<!-- /codex-only -->

## Pre-flight

Before any GitHub write, run the offline pre-flight with `node scripts/spec-to-issues.mjs plan <spec-path> --output <new-external-drafts.json>`. It reads `.github/labels.json` locally and saves drafts without printing the untriaged tree when `--output` is supplied. It reports every violation with the phase, slice, or section that owns it. Missing phase or slice fields, duplicate Plan IDs or titles, unknown blocked-by slices, dependency cycles, invalid sizes (only XS, S, M), invalid priorities, and unknown labels reject the whole plan. File nothing on any error. Never quietly drop a blocker, infer a missing acceptance criterion, or repair the spec as part of filing. Report the required corrections. Backlog is deferred under the template's rule; an active slice blocked by a deferred slice cannot be filed until the person resolves that dependency in the spec.

Build the whole tree offline: one root CONTAINER for the plan, one EPIC per active phase, one LEAF per slice, with a CONTAINER in place of a split slice and its nested leaves underneath. A filing request for the plan explicitly includes its phase epics. The helper's output is a draft, not the final triaged tree. Check the bodies against the spec and body-format reference, keeping Acceptance bullets verbatim and inheriting §20.3. Send §20.4 dependency order and parallel lanes only as context to the triager. Do not turn parallel lanes into groups.

## Triage

After pre-flight and before printing the tree, spawn one `{{prefix}}issue-triager` for the whole plan. Resolve settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a requested triager override. Stop on a resolver error. Send drafts (ref, title, body, parent ref, planned blocked-by refs), the spec's dependency context, the local label list, available Priority/Size options, and the reason (plan decomposition and dependency judgment). Pass each slice's Size, Priority (P2 unless the spec sets one), and labels as accepted decisions. In a plan or dry run, use the repository's documented options without writing or requiring project access. Before filing, discover the actual labels and project fields/options once through REST and stop on a mismatch instead of editing configuration.

Include `Policy: tool=<tool> role=issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)` in the packet.

<!-- claude-only -->
Spawn with the Agent tool, `subagent_type: {{prefix}}issue-triager`, passing `model` and `effort` from the resolver explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Spawn with `spawn_agent`, `agent_type: {{prefix}}issue-triager`, `model` and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Pass both settings explicitly. An unknown agent type means the project is not trusted; report it and stop.
<!-- /codex-only -->

Apply the triager's verdict, metadata, `EDGES` line, and groups and never override them. Add every returned edge to the saved drafts with `node scripts/spec-to-issues.mjs edges <drafts.json> '<EDGES line>' --output <new-external-triaged.json>`, which runs `applyEdges(plan, edgesLine)`. It adds each blocker to the waiting leaf's blocked-by refs and Dependencies section, and rejects malformed edges, unknown or non-leaf refs, self-edges, and cycles without writing anything. Stop on any error it reports, and continue from the triaged file. BLOCKED means stop before filing. On SPLIT_REQUIRED, draft the required split and obtain triage of the affected drafts and siblings as `{{prefix}}create-github-issue` does; show no fileable plan until it passes. Only the triager forms independence groups. Never form, extend, or merge groups yourself. Validate returned labels, sizes, references, parentage, and dependency acyclicity before continuing. Save the complete verdict, settings, metadata, edges, and groups in state for resume.

## Print and confirm

Print the same final tree for plan and file: number (ordinal until GitHub exists), kind, Plan ID or root/phase ref, size, priority, parent, blocked by, labels, title, plus the triager's independence groups by owning container and ungrouped leaves. Show excluded Backlog IDs separately. Include the full draft bodies as a local artifact the person can inspect. `printTree` in `scripts/spec-to-issues.mjs` formats nodes after applying the triager's metadata; print groups separately. A plan or dry run makes no GitHub writes, including no post-create commands.

For `file`, save the exact plan and its digest, then ask the person to confirm that printed tree. Wait for explicit confirmation. Confirmation is mandatory even though filing was requested. No timeout, previous spec review, or general filing authorization substitutes for confirmation of this tree. A change to the spec or triaged plan invalidates confirmation and requires new pre-flight, triage, printing, and confirmation. Save confirmation tied to the digest before the first GitHub write.

## File and resume

Follow [references/state.md](references/state.md) and [references/github-operations.md](references/github-operations.md). File parents before children, then native sub-issue links, then native blocked-by dependencies, including every edge the triager returned. Rewrite Plan ID and delivery-section references in issue bodies to issue numbers once the mapping exists. Keep design-section links to the spec. Write each independence record only after children, native parent links, and blocked-by edges exist.

Each independence record goes on the phase epic or split-slice container whose direct leaf children it lists, only when it has two or more leaf children and the triager returned groups for it. Use the exact marker format in `.agents/independence-groups.md` with issue numbers. The root container gets no record because its children are epics. Never move groups from one parent to another or infer a record from the spec's parallel lanes.

A resumed filing reuses the saved triager verdict and groups without spawning the triager again. Reconcile completed and pending writes with REST reads, adopt issues created by this run, skip existing parent links and dependencies, and finish every missing independence record. A spec change since the confirmed plan requires a new pre-flight, triage, and confirmation. Keep the earlier run's journal and mapping; never silently reuse old confirmation or mutate old issues to match a changed plan.

Never edit labels, project settings, or project Status. Never touch an issue this run did not create. Apply only the confirmed labels when creating issues; do not edit their labels afterward. Add each created issue to the project with `scripts/issue-project-membership.mjs`, never with a direct `POST` to the project's items, then set only Priority and Size on the item it prints. Once all relationships, bodies, and records are verified, run `node scripts/issue-triage.mjs --apply --issue N` per created issue and `node scripts/issue-containers.mjs --apply --issue N` for the root. These scripts' configured tracker behavior is the required post-create adapter; do not set Status yourself. Journal their attempts and results, and report unfinished work for any issue the membership script could not add. Do not poll remote CI.

## Return

Return the tree, issue URLs, dependency edges, independence groups, state path, finished and unfinished operations, and the triager's `Requested settings: Policy:` line verbatim. Include the advisory policy in Codex. A partial filing keeps its state and lists the exact resume command or invocation; never report the plan fully filed until bodies, native relationships, records, metadata, and post-create commands have been verified.
