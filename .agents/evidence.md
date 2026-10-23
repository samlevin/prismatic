# Evidence retrieval

Delivery owners (implementers, or the main thread for inline work) and code reviewers read this file once and follow it. It decides how you read, never how much: a review still covers the whole diff, the callers and tests it needs, and every acceptance criterion.

- Start with targeted searches and the relevant callers, and widen only as the evidence leads.
- Ask for what the task needs. Select GitHub response fields with `--jq`, page list endpoints with `--paginate`, and read the issue, comment, PR, or line range you need instead of printing whole responses.
- Read a file of up to about 400 lines whole, and a file you will edit whole at any size. For any other larger file, run `rg -n` first, then read the ranges the task needs. Never read a file again only to confirm that an edit applied.
- Do not load these by default: `package-lock.json`; generated `.claude/`, `.codex/`, and `.agents/skills/` output (read the `.agents/` source first); build output; snapshots; and test fixtures. Read the relevant parts when the change or an acceptance criterion involves them.
- Reuse evidence whose inputs have not changed: the same file content, the same base and head, the same query, or the same check at the same tested SHA. Run it again only when something it depends on changed.
- Keep validation output short. Filter a long log to its failures and a tail, and report the command, its result, and the failures. A filter must never hide a failing exit status.
- When output is truncated, or a page, range, or field is missing, fetch the missing part with a narrower query, a line range, or the next page before you edit, judge, or report from it.
- An agent that can write saves output too large to read at once to a file from `mktemp` and inspects it there in later steps. A read-only role, such as a code reviewer, never writes that file: it reruns the query in narrower bounded pieces until it has seen every part it needs.
- Facts a handoff supplied, such as acceptance criteria, accepted decisions, verified prerequisites, and SHAs, are evidence. Reuse them, and fetch only what is missing or may be stale, such as a branch head that could have moved.

The 400-line threshold decides how you read a file, never what a review covers: callers, tests, and every acceptance criterion are still inspected.
