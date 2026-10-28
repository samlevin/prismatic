# Body shapes

Every body is built offline from the specification, with issue numbers left as placeholders. `@@issue:KEY@@` stands for the issue of item `KEY`: `Plan` for the root container, `Phase 0` for an epic, `Stack P0.11` for a container (the stem of its layers), and the Plan ID for a leaf. The specification itself never contains `@@issue:` (rule `reserved-text`), so filling placeholders cannot touch the specification's own text, including template syntax in double braces. Filling replaces each placeholder with `#N`: the actual number once the item exists, otherwise its predicted number.

Write each body to `bodies/<KEY>.md` in the state directory (see [state-file.md](state-file.md)), with placeholders. Write the filled copy you send to GitHub to `sent/<KEY>.md`.

## Carried text and references

Carried text is any text copied from the specification: a phase's Goal and Exit criteria, a slice's Provides, Acceptance, Notes, Validation, and Spec, carried and owned sections, class catalog rows, and definition-of-done items. Carry it verbatim with two rewrites, applied outside code spans and fenced code only:

- A section reference `§x.y` becomes `§x.y (@@issue:OWNER@@)`, where OWNER owns `§x.y` or its nearest owned ancestor. A reference to a section the body's own item owns stays bare. A reference already followed by ` (#` is left alone.
- A Plan ID mention `Pn.m` becomes `Pn.m (@@issue:Pn.m@@)`. The item's own Plan ID stays bare.

A carried section is its heading line through the line before the next heading of the same or a higher level, minus any subsection that a different item claims. Shift every heading in it two levels deeper (`##` becomes `####`), capped at `######`, and leave fenced code untouched. When an item claims a section and one of its subsections, carry the section once. Carry sections in section-number order, separated by a blank line.

## Root container

One per specification, keyed `Plan`. The specification title is its first `# ` heading outside fenced code, minus a trailing word `specification` in any letter case; the root is titled `<specification title> delivery plan` (`# Notes service specification` becomes `Notes service delivery plan`). A heading that is only that word leaves nothing and fails `plan-section`. Labels `enhancement` and `severity: none`, never `epic`. Priority is the highest of its epics, Size `L`. It has no blocked-by edges.

```markdown
### What
The <specification title> delivery plan: the <count> <phase epic|phase epics> listed under How and every container and slice under them. This issue groups them and has no work of its own. It closes when the epics close.

### Why
`prism-implement` builds its dependency queue from one issue's native sub-issue tree and the blocked-by edges on its leaves. Without a common parent, `implement` could target only one phase at a time; with this issue as the parent of every phase epic, `implement` on it delivers the whole plan in dependency order.

### How
Phases in plan order:

1. P<id> <phase title>: @@issue:Phase <id>@@
...
<n>. P<id> <phase title>: @@issue:Phase <id>@@, deferred; blocked by <Pn.m> (@@issue:<Pn.m>@@), ...

Dispatch order comes from the native blocked-by edges on the slices, <edge count> of them, not from whole phases. The phase epics carry no blocked-by edges of their own apart from <the deferred one|the deferred ones>, and this issue adds none, so a slice becomes executable as soon as its own blockers close. Each epic's How section lists its slices with their blockers.

### Parent issue
None
```

When the specification title begins with `The`, the What line does not prepend another `The`. Phases are listed in specification order, every phase including deferred ones. A deferred phase's line ends with `, deferred; blocked by` and its `Deferred until` Plan IDs, each as `Pn.m (@@issue:Pn.m@@)`, comma-separated in `Deferred until` order. `<edge count>` is the number of blocked-by entries across all leaves. Write `phase epic` when the plan has one phase and `phase epics` otherwise. Write `the deferred one` when exactly one phase is deferred and `the deferred ones` when several are, and leave out the `apart from` phrase when none is.

## Epic

One per phase, titled with the phase title. Labels `epic` and `severity: none`.

```markdown
### What
<Goal, carried>

Slices:
- `<Plan ID>` <slice title> (<size>): @@issue:<Plan ID>@@
...

### Why
<Exit criteria, carried>

Deferred: filed now and blocked until <Pn.m> (@@issue:<Pn.m>@@), ... <closes|close>.

### How
Order by blocked-by, not by number:
- `<Plan ID>`: blocked by <Pn.m (@@issue:Pn.m@@), ...| none>
...
- Container @@issue:Stack <stem>@@ groups `<layer>`, `<layer>` as stacked deliveries.

Definition of done for every slice: §<n> (@@issue:<owner>@@).

### Parent issue
@@issue:Plan@@

### Contracts
<each section in the phase's Contracts, carried>
```

In the epic that owns the definition-of-done section, its pointer stays bare: `Definition of done for every slice: §<n>.` Every other epic and every leaf gets `§<n> (@@issue:<owner>@@)`, by the same rule as any carried reference. The `Deferred:` paragraph appears only for a deferred phase. It lists every `Deferred until` Plan ID, comma-separated in `Deferred until` order, and ends in `closes` for one and `close` for several (`blocked until P1.2 (#11), P1.3 (#12) close`). The container lines appear only when the phase has a stack. Leave out the Contracts heading when the phase claims no sections. Slices are listed in specification order.

When the triager returned groups for the epic, the skill's independence-groups step appends the section that `.agents/independence-groups.md` shows to the end of `bodies/<epic>.md`, one list item per group, with `@@issue:<Plan ID>@@` for each leaf in place of an issue number. The record then goes through every fill and patch like the rest of the body.

## Container

One per stack, titled with the `Stack` value. Labels `enhancement` and the first layer's severity.

```markdown
### What
Stacked slices `<Pn.ma>` (@@issue:<Pn.ma>@@), `<Pn.mb>` (@@issue:<Pn.mb>@@): each layer builds on the branch of the layer before it and is reviewed on its own.

### Why
Each layer is one reviewable delivery; the layers share one seam and land as stacked PRs.

### How
- `<Pn.ma>` then
- `<Pn.mb>`

### Parent epic
@@issue:Phase <id>@@
```

## Leaf

One per slice, titled with the slice title. Labels `enhancement`, the slice's severity (default `severity: none`), and its `risk:` and `area:` labels.

```markdown
### Parent epic
@@issue:Phase <id>@@

### Outcome
Plan ID: <Pn.m>. <Provides, carried>

### Acceptance criteria
- [ ] <each Acceptance item, carried>

### Implementation notes
<Notes, carried>

Files: `<file>`, `<file>`

Contracts: §<n> (@@issue:<owner>@@), ...

Owned contracts:

<each section in Owns, carried>

Class contracts:

<catalog rows, carried>

### Validation
- <each top-level item of the definition-of-done section, carried>
- <each Validation item of the slice, carried>
- Definition of done: §<n> (@@issue:<owner>@@).

### Dependencies
Blocked by: <Pn.m> (@@issue:<Pn.m>@@), ...
```

- A layer of a stack uses `### Parent issue` with `@@issue:Stack <stem>@@` instead of `### Parent epic`.
- Leave out any Implementation notes paragraph whose field is empty, and the whole heading when all are empty. A deferred-work table row often has only Notes.
- Class contracts: for each table in the class catalog section with a row whose file matches one of the slice's `Files` (matching rules in the guide), copy that table's header line, separator line, and matching rows, in catalog order. Tables are separated by a blank line.
- Dependencies reads `None` when the slice has no blockers.

## Heading check (rule `template-headings`)

Read the `label` of every non-markdown field in `.github/ISSUE_TEMPLATE/epic.yml`, `container.yml`, and `task.yml`, with its `validations.required` flag. List the body's `### ` headings outside fenced code. They must be the form's labels in form order: every required label present, optional ones (Implementation notes, Dependencies, Milestone) present or left out. The root uses `container.yml`. The field with `id: parent` may read either `Parent issue` or `Parent epic`; an epic's parent is the root container, so it reads `Parent issue`. The only other headings allowed are on an epic: `Contracts`, then `Independence groups`, which the groups step appends after pre-flight and which always comes last. Carried text shifted two levels never produces a `###` heading unless the specification has a `#` heading inside a numbered section, which this check catches.

## Size check (rule `body-size`)

Fill every placeholder with `#9999999` and count characters. The result must be under 65,536. Pre-flight runs before the groups step, so an epic with two or more direct leaf children also counts the largest record that step can append: the section `.agents/independence-groups.md` shows, with each of those leaves as `#9999999` in a group of its own.
