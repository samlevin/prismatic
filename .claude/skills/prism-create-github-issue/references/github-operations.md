# GitHub operations

Check `gh <cmd> --help` for flags supported by the installed version.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh issue create --repo samlevin/prismatic --title 'T' --body-file /abs/body.md --label 'L' [--type 'NativeType'] [--parent URL] [--blocked-by URL]`
Add `--type` only for a discovered native type. A blocker belongs in `--blocked-by`; do not reverse the direction. Do not rely on `--template` to fill forms or metadata. Capture the URL even on a non-zero exit, because a later metadata step can fail after the issue exists.

Relationships, if the CLI lacks flags: GraphQL `addSubIssue(issueId, subIssueId)` and `addBlockedBy(issueId, blockingIssueId)`, using node IDs from `gh issue view N --json id`. Never use displayed numbers as node IDs.

Project: select it by owner and number, never by title. Never add an issue to the project or set its Status yourself; a repository workflow adds every new issue when it opens and sets Status to Inbox.
`gh project view 2 --owner samlevin --format json --jq .id` gives the project ID (PID).
`gh project field-list 2 --owner samlevin --format json`
Find the item the workflow added: `gh api graphql -f query='query($id: ID!) { node(id: $id) { ... on Issue { projectItems(first: 100) { nodes { id project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' -f id=ISSUE_NODE_ID`, where ISSUE_NODE_ID comes from `gh issue view URL --json id`. The item is the node whose `project.id` is PID, and it is ready once its Status is set. Check every 10 seconds for up to 3 minutes. If it never appears or never gets a Status, keep the issue, skip its field edits, and report it as unfinished with what is missing: not on the project, or on it with no Status, Priority, or Size.
`gh project item-edit --id ITEM --project-id PID --field-id FID --single-select-option-id OID`
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back: `gh issue view URL --json title,body,labels,milestone,projectItems`, plus GraphQL `subIssues`, `parent`, `blockedBy`, and `blocking` to confirm direction.
