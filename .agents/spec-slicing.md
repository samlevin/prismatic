# Slicing a specification for filing

The `prism-spec-to-issues` skill files the delivery plan of a specification as one root container, an epic per phase under it, containers, and leaf issues. It reads the format in this guide and nothing else. A specification written to it files cleanly; one that breaks it fails pre-flight, and the failure names the rule from [Pre-flight rules](#pre-flight-rules). The skill source (`.agents/workflows/spec-to-issues.md` and `.agents/workflows/spec-to-issues/`) and this guide change together in the same PR: a new field, rule, or ownership convention goes into both.

`.agents/workflows/spec-to-issues/fixtures/conforming-spec.md` is a complete small example; read it next to this guide. `violating-spec.md` beside it breaks one rule.

## Numbered sections

The specification is one Markdown file whose first `# ` heading outside fenced code is its title, such as `# Notes service specification`. Normative content sits in numbered sections: `## 1. Title`, `### 1.2 Title`, `#### 1.2.3 Title`, and deeper. The number is the section's identity. Prose refers to a section as `§1.2`, and the skill rewrites every such reference to `§1.2 (#N)`, where `#N` is the issue that owns the section. References inside code spans and fenced code stay as written.

Every numbered section has exactly one owner, which is the issue whose body carries it verbatim. An owner carries a section's subsections too, except a subsection that another issue claims for itself. A reference to a section resolves to the owner of that section or of its nearest owned ancestor. The delivery plan section itself has no owner, so do not refer to it by number.

| Section kind | Owner |
| --- | --- |
| Product decisions, goals, architecture, the class catalog | The epic of the phase that first needs them, usually the first phase |
| Domain types | The slice that implements them (its `Owns` field) |
| Configuration | The slice that implements it |
| Directory layout | The scaffold slice |
| A section that describes deferred work | The epic of the deferred phase |
| Numbered subsections of the delivery plan (seam contracts, definition of done, dependency order) | An epic, usually the first phase |
| Any other section | The epic of the phase whose slices implement it |

A slice owns a section only when that slice implements all of it. A section that several slices read stays with an epic, and the slices point at it from their `Spec` field.

## Delivery plan

Exactly one numbered section is titled `Delivery plan`, for example `## 20. Delivery plan`. Before its first phase it declares two fields, each in a paragraph of its own:

```markdown
**Definition of done:** §20.3

**Class catalog:** §12
```

`Definition of done` is required. Each top-level list item of that section becomes a line of every leaf's Validation. `Class catalog` is optional. It names the section whose tables list classes and functions with their files. The skill copies a catalog row into a leaf when the row's file is one the slice's `Files` names.

A catalog row names its file as the last parenthesized code span of its first cell, such as ``| `parseSha(input): Sha` (`shared/identifiers.ts`) | ... |``. A `Files` entry matches a row when the row's path is a whole-segment suffix of it (`src/shared/identifiers.ts` matches `shared/identifiers.ts`), or when the entry ends in `/` and contains the row's path. `Files` entries may use braces: `` `src/shared/{path,errors}.ts` `` stands for two files.

## Phases

Each phase is a heading one level below the delivery plan heading, `### Phase <id>: <title>`, where the id is a number with an optional capital letter (`Phase 8A`). The phase becomes one epic, titled with the phase title. A phase has these fields, each in a paragraph of its own:

| Field | Required | Epic body |
| --- | --- | --- |
| `**Goal:**` | yes | What, followed by the list of slices and their issues |
| `**Exit criteria:**` | yes | Why |
| `**Contracts:**` | no | The listed sections, verbatim under a Contracts heading, with headings two levels deeper |
| `**Deferred until:**` | no | Marks the phase deferred and files its epic at Priority P3. It names one or more slices, comma-separated; each becomes a blocked-by edge on the epic, and the epic's Deferred paragraph and the root's How line list them in this order (`blocked until P1.2 (#11), P1.3 (#12) close`) |

The epic's How lists every slice with its blockers, names each container, and points at the definition of done.

## Slices

A slice is one reviewable delivery and becomes one leaf issue. Inside a phase, each slice is a heading one level below the phase heading:

```markdown
#### P0.2 Shared primitives · S

- **Blocked by:** P0.1
- **Spec:** §12.7
- **Files:** `src/shared/{path,errors}.ts`
- **Provides:** `normalizePath` and `normalizeError`
- **Acceptance:**
  - `normalizePath` rejects absolute paths and `..` segments.
  - `normalizeError` never includes a stack trace.
```

The heading is the Plan ID, the title, a middle dot, and the size: `XS`, `S`, or `M`. Work larger than `M` is two slices. Each field is a top-level list item whose label is bold and ends in a colon.

| Field | Required | Leaf body |
| --- | --- | --- |
| `Blocked by` | yes | Dependencies, and a native blocked-by link per Plan ID. Write `none` when nothing blocks the slice. |
| `Spec` | yes | The Contracts line of Implementation notes |
| `Files` | yes | The Files line of Implementation notes, and the class catalog rows those files implement |
| `Provides` | yes | Outcome, after `Plan ID: Pn.m.` |
| `Acceptance` | yes | Acceptance criteria, one checkbox per nested item, verbatim |
| `Owns` | no | Sections this slice carries verbatim under "Owned contracts" |
| `Notes` | no | The opening paragraph of Implementation notes |
| `Validation` | no | Extra nested items appended to Validation |
| `Stack` | no | The title of the container this slice is a layer of |
| `Risk` | no | `risk:` labels, such as `security` |
| `Area` | no | `area:` labels, such as `repository` |
| `Priority` | no | `P0` to `P3`; the default is P2, or P3 in a deferred phase |
| `Severity` | no | `critical`, `high`, `medium`, `low`, or `none` (the default) |

### Stacked slices and containers

Apart from the root container, a container exists only for slices delivered as stacked PRs. Give each layer the same `Stack` title and the same Plan ID stem with a letter suffix (`P0.11a`, `P0.11b`). Every layer after the first is blocked by the layer before it, and all layers sit in one phase. The container is titled with the `Stack` value, its parent is the phase's epic, and the layers are its sub-issues. Never use a container to group independent slices.

### Deferred work

A deferred phase lists its slices in a table instead of headings. The table's first header cell is `Plan ID`:

```markdown
| Plan ID | Title | Size | Blocked by | Provides | Acceptance |
| --- | --- | --- | --- | --- | --- |
| P9.1 | Second model adapter | M | P4.3 | A second provider behind the model port | Implements the model port<br>Maps refusals to typed failures |
```

The six columns above are required. `Spec`, `Files`, `Owns`, `Notes`, `Risk`, `Area`, `Priority`, and `Severity` may be added as columns. Separate acceptance items with `<br>`. A slice that moves to a deferred phase keeps its Plan ID.

## Plan IDs

A Plan ID is `P`, the phase id, a dot, a number, and an optional lowercase letter for a stacked layer: `P0.3`, `P8A.2`, `P0.11b`. Plan IDs are stable. Never renumber a slice or reuse a removed ID, because issues, branches, and other specifications refer to them. Every mention of a Plan ID in carried text is rewritten to `Pn.m (#N)`, so a mention of an ID that no slice has fails pre-flight.

## No filler

Every field states something the implementer needs. Leave an optional field out rather than writing `TBD`, `TODO`, `n/a`, or nothing. Acceptance items are observable conditions, not tasks. Issue titles in a plan are unique, because resuming an interrupted filing finds already-created issues by title.

## Root container

The skill files one container above the phase epics, so a single `implement` request on it delivers the whole plan: `prism-implement` builds its dependency queue from one issue's native sub-issue tree and the blocked-by edges on its leaves. Its sub-issues are every phase epic, deferred ones included, and nothing else. It is titled with the specification's title minus a trailing word `specification` in any letter case, followed by `delivery plan`, so `# Notes service specification` becomes `Notes service delivery plan`, and that title must be unique like any other. A title that is only the word `specification` leaves nothing and fails `plan-section`. It is created first, before the epics.

Its body follows `container.yml`. What names the specification and says the issue has no work of its own. Why says how that queue is built. How lists the phases in plan order with their epics, marks each deferred phase with the slices it waits for, and states that dispatch order comes from the slice-level blocked-by edges rather than whole phases. The root has no blocked-by edges of its own, and no specification field controls it.

## What the skill files

| Issue | Labels | Priority | Size | Parent |
| --- | --- | --- | --- | --- |
| One root container per specification | `enhancement` and `severity: none` | the highest of its epics | L | none |
| One epic per phase | `epic` and one severity | P2, or P3 when deferred | L | the root container |
| One container per stack | `enhancement` and one severity | the highest of its layers | L | the phase's epic |
| One leaf per slice | `enhancement`, one severity, and the slice's `risk:` and `area:` labels | from the slice | from the slice | the container, or else the phase's epic |

`epic` is the only work-category label on an epic, and the root never carries `epic`. Bodies follow `.github/ISSUE_TEMPLATE/epic.yml`, `container.yml`, and `task.yml`. A child of an epic uses the `Parent epic` heading; an epic uses `Parent issue` for the root. The skill never creates labels; every label the plan needs must already exist.

For each epic with two or more direct leaf slices, the skill asks `prism-issue-triager` to sort those leaves into independence groups from their `Files` and blocked-by edges, and records the groups in the epic's body as `.agents/independence-groups.md` defines. Slices whose `Files` overlap never land in different groups, so the delivery queue's parallel exception never runs them together.

## Pre-flight rules

The skill builds the whole plan offline and checks it before any GitHub call. It checks the rules in the order below and stops at the first rule that fails, before the first issue exists. Each violation it reports starts with the rule name in brackets, such as `[acyclic] Blocked-by cycle: P0.1 -> P0.2 -> P0.1.`

| Rule | Fails when |
| --- | --- |
| `reserved-text` | The specification contains `@@issue:`, the skill's issue-number placeholder |
| `plan-section` | The specification has no `# ` title heading outside fenced code, its title is empty after the trailing word `specification` is removed, there is not exactly one `Delivery plan` section, or its definition of done or class catalog field names a missing section |
| `phase-format` | A phase heading is malformed, a phase id repeats, or Goal or Exit criteria is missing |
| `slice-format` | A slice heading is malformed, the size is not `XS`, `S`, or `M`, a required field or table column is missing, or a field is unknown |
| `slice-unique` | A Plan ID appears in more than one slice |
| `title-unique` | Two issues in the plan have the same title |
| `blocked-by-resolves` | A `Blocked by` or `Deferred until` entry names no slice, or a slice blocks itself |
| `acyclic` | The blocked-by graph has a cycle |
| `stack-shape` | A stack has fewer than two layers, spans phases, mixes Plan ID stems, or a layer is not blocked by the layer before it |
| `section-owner` | A claimed section does not exist, a section is claimed twice, the delivery plan section is claimed, or a numbered section other than the delivery plan has no owner |
| `section-reference` | A `§` reference names a missing section or one with no owner |
| `plan-id-reference` | A Plan ID mention names no slice |
| `no-filler` | A field is empty or holds a placeholder such as `TBD` |
| `label-exists` | A label is missing from `.github/labels.json`, or from the repository when filing |
| `body-size` | A rendered body, the root's included, reaches 65,536 characters; an epic's counts its largest possible independence record |
| `template-headings` | A rendered body's headings, the root's included, do not match its issue form |
