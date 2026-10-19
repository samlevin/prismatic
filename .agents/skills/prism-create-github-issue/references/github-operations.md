# GitHub operations

Every call is REST through `gh api`. R is `samlevin/prismatic`, P is `2`. `-F name=@FILE` reads a value from a file, and `-F` (not `-f`) sends integers.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh api -X POST repos/R/issues -f title='T' -F body=@/abs/body.md -f 'labels[]=L' [-f type='NativeType'] --jq '{number, id, html_url}'`
Repeat `-f 'labels[]=…'` once per label. Add `type` only for a discovered native type, and `-f 'assignees[]=LOGIN'` or `-F milestone=NUMBER` only when the request or policy calls for them. Do not rely on a template to fill forms or metadata. Record the number, REST `id`, and URL as soon as the create returns, because a later relationship or metadata step can fail after the issue exists.

Relationships use the REST `id` from the create response, never the displayed number:
- Parent: `gh api -X POST repos/R/issues/PARENT/sub_issues -F sub_issue_id=CHILD_ID`.
- Blocked by: `gh api -X POST repos/R/issues/N/dependencies/blocked_by -F issue_id=BLOCKER_ID`. N is the blocked issue and BLOCKER_ID is the blocker's `id`; do not reverse the direction.

Independence record: `gh api repos/R/issues/PARENT --jq .body > /abs/parent.md`, append the section, then `gh api -X PATCH repos/R/issues/PARENT -F body=@/abs/parent.md --jq .html_url`. Replace an existing section instead of appending a second one.

Project: select it by owner and number, never by title. Never add an issue to the project or set its Status yourself; a repository workflow adds every new issue when it opens and sets Status to Inbox.
`gh api users/samlevin/projectsV2/P/fields --jq '.[] | {id, name, options: [.options[]? | {id, name: .name.raw}]}'` gives the field IDs and option IDs.
Find the item the workflow added: `gh api 'users/samlevin/projectsV2/P/items?per_page=100&fields=STATUS_FIELD_ID' --paginate --jq '.[] | select(.content.id == ISSUE_ID) | {item: .id, status: ([.fields[] | select(.name == "Status") | .value.name.raw] | first)}'`, where ISSUE_ID is the REST `id` from the create. One listing covers every issue in the batch. The item is ready once its Status is set. Check every 10 seconds for up to 3 minutes. If it never appears or never gets a Status, keep the issue, skip its field edits, and report it as unfinished with what is missing: not on the project, or on it with no Status, Priority, or Size.
Set Priority and Size: `gh api -X PATCH users/samlevin/projectsV2/P/items/ITEM --input /abs/fields.json`, with `fields.json` as `{"fields": [{"id": PRIORITY_FIELD_ID, "value": "OPTION_ID"}, {"id": SIZE_FIELD_ID, "value": "OPTION_ID"}]}`. Field IDs are the numeric `id` values; option IDs are the option `id` strings.
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back:
- Title, body, labels, milestone: `gh api repos/R/issues/N --jq '{title, body, labels: [.labels[].name], milestone: .milestone.title}'`.
- Parent: `gh api repos/R/issues/N/parent --jq .number` (HTTP 404 means no parent); children: `gh api 'repos/R/issues/N/sub_issues?per_page=100' --paginate --jq '.[].number'`.
- Dependencies, to confirm direction: `gh api 'repos/R/issues/N/dependencies/blocked_by?per_page=100' --paginate --jq '.[].number'` and the same path ending in `blocking`.
- Project fields: `gh api 'users/samlevin/projectsV2/P/items/ITEM?fields=STATUS_FIELD_ID,PRIORITY_FIELD_ID,SIZE_FIELD_ID' --jq '[.fields[] | {name, value: .value.name.raw}]'`.
