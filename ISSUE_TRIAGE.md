# Issue triage

This file owns classification. [Automation](CONTRIBUTING.md#automation) describes the workflows that apply it to the project.

Use [Prismatic delivery](https://github.com/users/samlevin/projects/2) for Priority, Size, and Status. Default Priority is **P2**. Assign one severity label to every issue, including containers.

| Severity | Meaning | Default priority |
| --- | --- | --- |
| critical | Outage, data loss, serious security impact | P0 while active; otherwise P1 |
| high | Important functionality broken | P1 |
| medium | Bounded functional defect | P2 |
| low / none | Minor defect / planned work | P2; P3 when optional |

Deadlines and blocking dependencies can raise priority.

| Size | Scope |
| --- | --- |
| XS | Narrow edit |
| S | One component |
| M | One outcome across cooperating components |
| L | Needs planning or decomposition |

Split multiple logical outcomes into native sub-issues, even when small. Size alone does not create an epic. M and larger work can use stacked PRs for reviewable layers; retain the production-code size guidance in [Pull requests](CONTRIBUTING.md#pull-requests).

## Labels

Use plain descriptive issue titles without `[Type]:` prefixes. Labels are canonical for classification.

Use existing `bug`, `enhancement`, or `documentation` labels where applicable, one `severity:` label, and labels for directly affected `package:` workspaces. Repository work uses `area: repository`. Apply exceptional `risk:` labels only when useful. Avoid duplicate `type: bug` and package/area pairs. Apply `epic` only when epic creation was explicitly requested. An epic uses `epic` as its only work-category label: never combine it with `bug`, `enhancement`, `documentation`, or other standard categories. Severity, package/area, risk, and automation metadata may coexist with `epic`. Other standard labels remain available on non-epic issues. See [.github/labels.json](.github/labels.json) for exact names. The issue description supplies context; do not justify each label individually.

## Planning and hierarchy

A leaf issue delivers one logical feature, bug, or change with observable acceptance criteria. Any issue with native sub-issues is a container and never has its own implementation branch or PR. Containers can contain other containers. Epics are explicitly requested, notable bodies of work, often linked to a requested milestone; ordinary multi-part requests become an Issue with Sub-issues. Use `Parent epic` in a child body only when its immediate parent is an epic, otherwise `Parent issue`.

Containers use only What, Why, and How for their planning body, plus applicable relationship/milestone metadata. They have no acceptance criteria. Containers use `container.yml` and epics use `epic.yml`. Only executable leaves use a deliverable template, `task.yml` or `bug.yml`, with acceptance criteria and validation. Put any integration or verification work in executable children; closure follows child completion.
