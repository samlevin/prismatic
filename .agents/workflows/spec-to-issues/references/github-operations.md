# GitHub operations

Every call is REST through `gh api`. Pass JSON bodies from a file outside the repository with `--input FILE`, and integers with `-F` (not `-f`). Projects v2 paths below use `users/{{project.owner}}`; for a project owned by an organization use `orgs/<org>` instead. R is `{{repository}}`, P is `{{project.number}}`.

## Pacing and retries

- Leave at least 3 seconds between issue creates and at least 1 second between any other writes (POST, PATCH, DELETE). Reads need no gap. Chain the wait into the same shell command as the call (`gh api ... && sleep 3`).
- GitHub's secondary rate limit answers a write with HTTP 403 or 429 and a message about a secondary rate limit, sometimes with a `retry-after` header (see it with `gh api --include`). Wait `retry-after` seconds, or 60 seconds without one, then retry. Double the wait on each further limit, and stop after five retries; the state file lets a later run resume.
- A create that fails any other way, or times out, may still have created the issue. Run the title lookup under [Resume lookup](#resume-lookup) before retrying it.

## Reads before filing

| Purpose | Call |
| --- | --- |
| Authenticated login | `gh api user --jq .login` |
| Labels that exist | `gh api 'repos/R/labels?per_page=100' --paginate --jq '.[].name'` |
| Assignee is assignable | `gh api repos/R/assignees/LOGIN` succeeds (HTTP 204); a 404 means not assignable |
| Project fields | `gh api users/{{project.owner}}/projectsV2/P/fields --jq '.[] \| select(.name=="Priority" or .name=="Size") \| {id, name, options: [.options[] \| {id, name: .name.raw}]}'` |
| Latest issue or PR number | `gh api 'repos/R/issues?state=all&sort=created&direction=desc&per_page=1' --jq '.[0].number'` |

The issues list includes pull requests, which share the number sequence. Discussions share it too and do not appear there, which is one reason a prediction can miss.

## Create

```console
gh api -X POST repos/R/issues --input /abs/state/create.json --jq '{number, id, node_id, html_url}'
```

`create.json` is `{"title": "...", "body": "<filled body>", "labels": [...], "assignees": ["LOGIN"]}`, with `assignees` left out when there is no assignee. Build it with a JSON tool (`jq -n --rawfile body sent/KEY.md ...`), never by pasting the body into a shell string.

## Body patch

```console
gh api -X PATCH repos/R/issues/N --input /abs/state/patch.json --jq .number
```

`patch.json` is `{"body": "<filled body>"}`. Patch only issues recorded in the state file.

## Sub-issues

- List: `gh api 'repos/R/issues/PARENT/sub_issues?per_page=100' --paginate --jq '.[].number'`
- Add: `gh api -X POST repos/R/issues/PARENT/sub_issues -F sub_issue_id=CHILD_ID`, where CHILD_ID is the child's REST `id`, not its number.

## Blocked-by dependencies

- List: `gh api 'repos/R/issues/N/dependencies/blocked_by?per_page=100' --paginate --jq '.[].number'`
- Add: `gh api -X POST repos/R/issues/N/dependencies/blocked_by -F issue_id=BLOCKER_ID`. N is the blocked issue; BLOCKER_ID is the blocker's REST `id`. Do not reverse the direction.

## Project items

- Find: `gh api 'users/{{project.owner}}/projectsV2/P/items?per_page=100' --paginate --jq '.[] | select(.content_type=="Issue") | {item: .id, issue: .content.id}'`, then match `issue` to the recorded issue `id`.
- Add, only when the repository automation has not added the issue after 3 minutes: `gh api -X POST users/{{project.owner}}/projectsV2/P/items -f type=Issue -F id=ISSUE_ID`.
- Set Priority and Size: `gh api -X PATCH users/{{project.owner}}/projectsV2/P/items/ITEM --input fields.json`, with `fields.json` as `{"fields": [{"id": PRIORITY_FIELD_ID, "value": "OPTION_ID"}, {"id": SIZE_FIELD_ID, "value": "OPTION_ID"}]}`. Field IDs are the numeric `id` values from the fields read; option IDs are the option `id` strings.
- Never set Status. The repository automation sets Inbox, and `scripts/issue-triage.mjs` moves an issue to Ready.

## Resume lookup

```console
gh api 'repos/R/issues?creator=LOGIN&state=all&since=STARTED_AT&per_page=100' --paginate \
  --jq '.[] | select(.pull_request | not) | {number, id, node_id, title, created_at}'
```

An issue in this list whose title equals an item's title, created at or after `startedAt`, is that item. Adopt it: record its number and IDs, and record `sentSha256` as the hash of its current body (`gh api repos/R/issues/N --jq .body`). Two matches for one title means a duplicate already exists; stop and report both numbers instead of choosing.

## Read back

- Body, labels, assignees: `gh api repos/R/issues/N --jq '{title, labels: [.labels[].name], assignees: [.assignees[].login], body}'`
- Parent: `gh api repos/R/issues/N --jq .parent_issue_url` when present, or the sub-issue list of the parent.
- Dependencies: the blocked-by list above.
- Project fields: `gh api 'users/{{project.owner}}/projectsV2/P/items/ITEM?fields=PRIORITY_FIELD_ID,SIZE_FIELD_ID,STATUS_FIELD_ID' --jq '[.fields[] | {name, value: .value.name.raw}]'`
