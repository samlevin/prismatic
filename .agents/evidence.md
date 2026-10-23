# Evidence retrieval

Delivery owners, isolated implementers, and code reviewers read this file once and follow it. It decides how you read, never how much: a review still covers the whole diff, the callers and tests it needs, and every acceptance criterion.

- Start with targeted searches and the relevant callers, and widen only as the evidence leads.
- Ask for what the task needs. Select GitHub response fields with `--jq`, page list endpoints with `--paginate`, and read the issue, comment, PR, or line range you need instead of printing whole responses.
- Read a short file whole when that helps. Read a long file by the line ranges the task needs, with enough surrounding text to understand the code or rule. About 2,000 lines is a rough point to switch to ranges, not a threshold that requires a full read; long lines and large output count too.
- Reuse evidence whose inputs have not changed and that is still in your context: the same file content, the same base and head, the same query, or the same check at the same tested SHA. Never repeat an identical read or search only for reassurance, and never read a file you already inspected in full again in pieces without a new reason.
- Read again, as narrowly as the need allows, when context was compacted or lost a detail you need, when the file or something it depends on changed, when you find a new dependency, or when you have a specific doubt. No fixed count limits these reads.
- A successful edit or `apply_patch` shows that the edit applied, so never read a file again only to confirm that. Checking that the edit is correct and keeps its meaning is a separate inspection.
- Keep validation output short. Filter a long log to its failures and a tail, and report the command, its result, and the failures. A filter must never hide a failing exit status.
- When output is truncated, or a page, range, search hit, or field is missing, fetch the missing part with a narrower query, a line range, or the next page before you edit, judge, or report from it.
- An agent that can write saves output too large to read at once to a file from `mktemp` and inspects it there in later steps. A read-only role, such as a code reviewer, never writes that file: it reruns the query in narrower bounded pieces until it has seen every part it needs.
- Facts a handoff supplied, such as acceptance criteria, accepted decisions, verified prerequisites, and SHAs, are evidence. Reuse them, and fetch only what is missing or may be stale, such as a branch head that could have moved.

Narrow a read because the task needs less, never to meet a size or a count.
