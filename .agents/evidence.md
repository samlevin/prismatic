# Evidence retrieval

Delivery owners, isolated implementers, and code reviewers read this file once and follow it. It decides how you read, never how much: a review still covers the whole diff, the callers and tests it needs, and every acceptance criterion.

- Ask for what the task needs. Select GitHub response fields with `--jq`, page list endpoints with `--paginate`, and read the issue, comment, PR, or line range you need instead of printing whole responses.
- Read a file you will edit, or a short file, whole. Read a long file by the line ranges the task needs. Never read a file again only to confirm that an edit applied.
- Reuse evidence whose inputs have not changed: the same file content, the same base and head, the same query, or the same check at the same tested SHA. Run it again only when something it depends on changed.
- Keep validation output short. Filter a long log to its failures and a tail, and report the command, its result, and the failures. A filter must never hide a failing exit status.
- When output is truncated, or a page, range, or field is missing, fetch the missing part with a narrower query, a line range, or the next page before you edit, judge, or report from it.
- Facts a handoff supplied, such as acceptance criteria, accepted decisions, verified prerequisites, and SHAs, are evidence. Reuse them, and fetch only what is missing or may be stale, such as a branch head that could have moved.

Narrow a read because the task needs less, never to meet a size or a count.
