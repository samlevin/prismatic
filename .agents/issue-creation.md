# Prismatic issue creation

Use the repo's issue forms and [labels](../.github/labels.json). Read the triage table in [CONTRIBUTING.md](../CONTRIBUTING.md) when you classify a draft.

- Plain titles, with no `[Type]:` prefix.
- Set Priority (default P2), Size, one severity, and `area:` labels. Use `bug`, `enhancement`, or `documentation`. Use `epic` only when explicitly requested, and then as the sole work-category label.
- Multiple outcomes become native sub-issues under `container.yml` (What/Why/How, no acceptance criteria). Leaves use `task.yml` or `bug.yml` with acceptance criteria.
- After creating them, run `node scripts/issue-triage.mjs --apply --issue N` for each new issue and `node scripts/issue-containers.mjs --apply --issue N` for each new top-level container.

## Independence groups

Only `prism-issue-triager` forms independence groups, for a new container or epic with two or more leaf drafts. Leaves in different groups must be independent:

- No blocked-by edge links them in either direction, directly or through another leaf.
- They share no unmerged ancestor branch, so neither stacks on the other or on a common open PR.
- Their implementation notes name no overlapping files or shared contracts.

Leaves in one group may depend on each other, because they run one at a time. A leaf that fits no group stays out of every group, and leaves stay in one group when the drafts do not settle a condition. Groups exist only when at least two form.

Once the children exist, the filing flow records the groups by appending this section to the parent body, one list item of issue numbers per group. A new record replaces an existing section instead of adding a second one.

```markdown
### Independence groups

<!-- prism-independence-groups -->
- #12 #14
- #13
<!-- /prism-independence-groups -->
```

`prism-implement` reads a leaf's record only from its immediate parent. It treats the leaf as unlisted when the section does not parse, when the leaf appears in two groups, or when a native blocked-by edge now links it to a leaf in another group. A valid record makes leaves eligible for the delivery queue's parallel exception. Delivery stays sequential unless the request asks for parallel delivery, and a request never widens the record.
