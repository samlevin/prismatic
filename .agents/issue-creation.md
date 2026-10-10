# Prismatic issue creation

Use the repo's issue forms and [labels](../.github/labels.json).

- Plain titles, with no `[Type]:` prefix.
- Set Priority (default P2), Size, one severity, and `area:` labels. Use `bug`, `enhancement`, or `documentation`. Use `epic` only when explicitly requested, and then as the sole work-category label.
- Multiple outcomes become native sub-issues under `container.yml` (What/Why/How, no acceptance criteria). Leaves use `task.yml` or `bug.yml` with acceptance criteria.
- After creating them, run `node scripts/issue-triage.mjs --apply --issue N` for each new issue and `node scripts/issue-containers.mjs --apply --issue N` for each new top-level container.
