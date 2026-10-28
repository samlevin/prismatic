# GitHub operations

Every call here is REST through `gh api`. `gh issue`, `gh project`, and `gh api graphql` spend the GraphQL limit, so none of them appear here. The one exception is the repository's membership script below, which makes its own GraphQL calls, about 2 points per issue. When `gh api` needs an option you are unsure of, check `gh api --help`.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh api repos/samlevin/prismatic/issues -f title='T' -F body=@/abs/body.md -f 'labels[]=L' [-f type='NativeType'] [-f 'assignees[]=LOGIN'] [-F milestone=NUMBER] --jq '"\(.number) \(.id) \(.html_url)"'`
Repeat `-f 'labels[]=...'` once per label. Add `type` only for a discovered native type. Record the number, the numeric `id`, and the URL from the response. GitHub silently drops labels, type, assignees, and milestone it will not set, so the read-back confirms them. Do not rely on templates to fill forms or metadata.

Relationships use the numeric `id` of the other issue, from the create response or `gh api repos/samlevin/prismatic/issues/N --jq .id`. Never use a displayed number or a `node_id` in its place.

- Parent link: `gh api repos/samlevin/prismatic/issues/PARENT/sub_issues -F sub_issue_id=CHILD_ID`, where PARENT is the parent's number.
- Blocked-by edge: `gh api repos/samlevin/prismatic/issues/BLOCKED/dependencies/blocked_by -F issue_id=BLOCKER_ID`, where BLOCKED is the number of the issue that waits. The blocker's `id` goes in the body; do not reverse the direction.

Independence record: after the children exist, read the container's current body with `gh api repos/samlevin/prismatic/issues/N --jq .body`, where N is the container's number. Write that whole body, with the section appended, to a scratch file, then update it with `gh api -X PATCH repos/samlevin/prismatic/issues/N -F body=@/abs/body.md`.

Project: select it by owner and number, never by title.
`gh api users/samlevin/projectsV2/2/fields --paginate`
Each single-select field lists its `options` with their `id` and `name`. Add each new issue to the project with the repository script, never with a direct `POST` to the project's `items`:
`CONTENT_TYPE=issue CONTENT_NUMBER=N DRY_RUN=false npx agenticool-tracker membership`
It prints `Issue #N: in Prismatic delivery as item ITEM.`, where ITEM is the numeric item ID. When the membership workflow already added the issue, the script prints that existing item and adds nothing. If the script exits non-zero, or prints no item line (it warns and exits 0 when the GraphQL limit is spent), skip that issue's fields and post-create commands and report it as unfinished: name the issue, say that it is not in the project and its fields are unset, and include the script's output. Once you have the item, write `{"fields":[{"id":FID,"value":"OID"}]}` to a scratch file, with one entry per field (FID is the numeric field ID, OID the option ID), and set the fields:
`gh api -X PATCH users/samlevin/projectsV2/2/items/ITEM --input /abs/fields.json`
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back with REST:

- `gh api repos/samlevin/prismatic/issues/N` for the title, body, labels, type, assignees, and milestone.
- `gh api -X GET users/samlevin/projectsV2/2/items/ITEM -f fields=FID,FID` for project membership and field values. Without `fields`, only the title comes back.
- `gh api repos/samlevin/prismatic/issues/N/sub_issues --paginate`, `gh api repos/samlevin/prismatic/issues/N/parent` (404 when the issue has no parent), `gh api repos/samlevin/prismatic/issues/N/dependencies/blocked_by --paginate`, and `gh api repos/samlevin/prismatic/issues/N/dependencies/blocking --paginate` to confirm direction.
