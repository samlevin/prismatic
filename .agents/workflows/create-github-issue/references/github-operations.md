# GitHub operations

Check `gh <cmd> --help` for flags supported by the installed version.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh issue create --repo {{repository}} --title 'T' --body-file /abs/body.md --label 'L' [--type 'NativeType'] [--parent URL] [--blocked-by URL]`
Add `--type` only for a discovered native type. A blocker belongs in `--blocked-by`; do not reverse the direction. Do not rely on `--template` to fill forms or metadata. Capture the URL even on a non-zero exit, because a later metadata step can fail after the issue exists.

Relationships, if the CLI lacks flags: GraphQL `addSubIssue(issueId, subIssueId)` and `addBlockedBy(issueId, blockingIssueId)`, using node IDs from `gh issue view N --json id`. Never use displayed numbers as node IDs.

Project: select it by owner and number, never by title.
`gh project field-list {{project.number}} --owner {{project.owner}} --format json`
`gh project item-add {{project.number}} --owner {{project.owner}} --url ISSUE --format json` (check for existing membership first; template or project automation may have already added it)
`gh project item-edit --id ITEM --project-id PID --field-id FID --single-select-option-id OID`
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back: `gh issue view URL --json title,body,labels,milestone,projectItems`, plus GraphQL `subIssues`, `parent`, `blockedBy`, and `blocking` to confirm direction.
