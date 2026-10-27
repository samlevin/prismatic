# Draft bodies

Read the repository's `task.yml`, `container.yml`, and `epic.yml` issue forms. The offline helper returns stable refs, fields, and draft bodies; these refs are local identities until filing assigns numbers.

| Node | Body |
| --- | --- |
| Root container | What is the spec's delivery plan; Why links the spec's purpose; How lists phase refs in delivery order. Parent issue is None. No leaf acceptance criteria. |
| Phase epic | What carries the phase Goal verbatim; Why links the spec; How carries Exit criteria verbatim and slice refs. Parent issue is the root. `epic` is the sole work-category label. |
| Split-slice container | What describes the slice; How keeps its Plan ID, Files, Provides, Spec links, inherited acceptance scope and §20.3, and lists its nested leaves. Parent epic is the phase. It groups work and owns no deliverable acceptance checklist. |
| Leaf | Use task fields Parent epic (or Parent issue for a split child), Outcome, Acceptance criteria, Implementation notes, Validation, Dependencies. Outcome includes `Plan ID: P<n>.<m>` (or the nested ID). Acceptance is the slice's bullets verbatim, followed by §20.3 verbatim. Notes include linked Spec sections, Files, and Provides. Validation names the relevant spec/repository checks; never claim they ran. |

A split child's acceptance must cover its independently testable part of its container's scope. Preserve the container's requirements across its children. Do not invent a split during a parser correction; a triager's SPLIT_REQUIRED verdict follows the workflow's re-triage rule.

Before filing, make a reference map for every Plan ID, phase heading and slice heading. After all issue numbers exist, render bodies again from saved drafts. Replace `Plan ID: P0.1` with `Plan ID: #<number>`, parent refs, dependency refs, child refs, and references to delivery phase/slice sections with their issue numbers. A bare section such as §7.1 continues to link to its design heading in the source spec. Never replace a design-section number with an issue number. Preserve all other Acceptance and definition-of-done wording. Save both the original drafts and final rendered bodies so resume uses identical content. Do not edit the source spec.

If a section or Plan ID points outside this plan, stop before filing unless the spec supplies an existing issue number and the confirmed plan explicitly includes that external relationship. The helper accepts local Plan IDs only; such an external relationship requires a spec correction to a supported local plan before this workflow files it. Never interpret a Plan ID from another spec as a local slice with the same ID.
