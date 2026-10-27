# Prismatic issue creation

Use the repo's issue forms and [labels](../.github/labels.json). The [triage section of CONTRIBUTING.md](../CONTRIBUTING.md#triage) owns severity, Priority (default P2), Size, and the type and `area:` labels. The `prism-create-github-issue` skill owns the filing order and the post-create commands. [Independence groups](independence-groups.md) owns the group definition and record format; read it only when the triager returns groups.

- Plain titles, with no `[Type]:` prefix.
- Use `epic` only when explicitly requested, and then as the sole work-category label. Size alone never makes an epic.
- One logical outcome is a LEAF, filed with `task.yml` or `bug.yml` and acceptance criteria. Multiple independent outcomes are SPLIT_REQUIRED: split them into leaves. An issue that has or will have children is a CONTAINER, filed with `container.yml` (What/Why/How, no acceptance criteria), and its leaves are native sub-issues.

An issue that removes or rewrites text, rules, or behavior lists what must be kept, as acceptance criteria an implementer can check. Implementation notes state the intent and the behavior affected. Quoted strings may show where to look, but never stand alone as a find-and-replace list.
