# Evidence and waiting

Every delivery owner, isolated implementer, and code reviewer reads this file once and follows it. It decides how evidence is retrieved, never how much relevant evidence must be inspected: full review coverage, the callers and tests of changed code, and every acceptance criterion stay required.

## Retrieve what the task needs

- Start with targeted `rg` searches, the changed paths, and relevant callers and tests, and follow references that reveal more in-scope behavior. Select GitHub response fields with `--jq`, page list endpoints with `--paginate`, and fetch only the issue, item, comment, or PR you need.
- Read a file of up to about 400 lines whole; for larger files, run `rg -n` first and read the ranges the task needs. Never read a file you already read whole again in chunks.
- Do not load `package-lock.json`, generated `.claude/` or `.codex/` output, build output, snapshots, or evidence fixtures such as raw MIME and screenshots unless the change or an acceptance criterion involves them. Read the `.agents/` source before generated instructions.
- Read each unchanged file once. After an edit, inspect the changed regions with enough surrounding text to check their meaning, including whether nearby unchanged statements still hold, and for a changed canonical source, the corresponding regions of one generated file. After a rename or move, search for other statements of the rule and the old name. Never reread only to confirm that an edit applied.
- Reuse evidence whose inputs have not changed: the same path and content, base and head, query, or validation command with unchanged code, dependencies, configuration, and environment. A new commit SHA alone does not invalidate a successful check. Facts a handoff supplied, such as acceptance criteria, decisions, verified prerequisites, and SHAs, are evidence too; retrieve only what is missing or may be stale, such as a branch head that could have moved.
- Save oversized responses, diffs, and full logs to a local temporary file outside tracked paths and inspect it with targeted searches or ranges. Keep the file available through delivery or review. Keep validation output short: pipe long logs through `tail -n 60` or a filter that keeps every failure, and report the command, its result, and the relevant failures. Never let a filter hide a failing exit status.
- Output that was not truncated is complete. When output is truncated or a page, range, or field is missing, retrieve the missing part with a narrower pattern, a range, or the next page before you edit, judge, or report from it. Never act on partial output.

These rules set no character budget, ledger, or counting step; narrow a retrieval only because the task needs less.

## Wait for events

- While a child agent or a long command runs and no other authorized work remains, wait with the tool's own wait mechanism for the longest timeout allowed. A blocking agent call already waits.
- Stay idle until a result, a substantive child message, or user input arrives. A timeout is not new information: wait again without status probes, agent listings, output rereads, or status-only messages. A progress update the tool requires is the one exception.
- Send a child only new evidence, a decision, a correction, or an answer it needs. Respond to user steering promptly.
- Never coordinate with shell sleep loops or polling, and never wait for, poll, or rerun remote CI.
