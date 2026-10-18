# Body shapes

Every body is built offline from the specification, with issue numbers left as placeholders. `@@issue:KEY@@` stands for the issue of item `KEY`: `Phase 0` for an epic, `Stack P0.11` for a container (the stem of its layers), and the Plan ID for a leaf. The specification itself never contains `@@issue:` (rule `reserved-text`), so filling placeholders cannot touch the specification's own text, including template syntax in double braces. Filling replaces each placeholder with `#N`: the actual number once the item exists, otherwise its predicted number.

Write each body to `bodies/<KEY>.md` in the state directory (see [state-file.md](state-file.md)), with placeholders. Write the filled copy you send to GitHub to `sent/<KEY>.md`.

## Carried text and references

Carried text is any text copied from the specification: a phase's Goal and Exit criteria, a slice's Provides, Acceptance, Notes, Validation, and Spec, carried and owned sections, class catalog rows, and definition-of-done items. Carry it verbatim with two rewrites, applied outside code spans and fenced code only:

- A section reference `§x.y` becomes `§x.y (@@issue:OWNER@@)`, where OWNER owns `§x.y` or its nearest owned ancestor. A reference to a section the body's own item owns stays bare. A reference already followed by ` (#` is left alone.
- A Plan ID mention `Pn.m` becomes `Pn.m (@@issue:Pn.m@@)`. The item's own Plan ID stays bare.

A carried section is its heading line through the line before the next heading of the same or a higher level, minus any subsection that a different item claims. Shift every heading in it two levels deeper (`##` becomes `####`), capped at `######`, and leave fenced code untouched. When an item claims a section and one of its subsections, carry the section once. Carry sections in section-number order, separated by a blank line.

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

Deferred: filed now and blocked until <Pn.m> (@@issue:<Pn.m>@@) closes.

### How
Order by blocked-by, not by number:
- `<Plan ID>`: blocked by <Pn.m (@@issue:Pn.m@@), ...| none>
...
- Container @@issue:Stack <stem>@@ groups `<layer>`, `<layer>` as stacked deliveries.

Definition of done for every slice: §<n> (@@issue:<owner>@@).

### Parent epic
None

### Contracts
<each section in the phase's Contracts, carried>
```

The `Deferred:` paragraph appears only for a deferred phase. The container lines appear only when the phase has a stack. Leave out the Contracts heading when the phase claims no sections. Slices are listed in specification order.

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

Read the `label` of every non-markdown field in `.github/ISSUE_TEMPLATE/epic.yml`, `container.yml`, and `task.yml`, with its `validations.required` flag. List the body's `### ` headings outside fenced code. They must be the form's labels in form order: every required label present, optional ones (Implementation notes, Dependencies, Milestone) present or left out. The field with `id: parent` may read either `Parent issue` or `Parent epic`. The only other heading allowed is `Contracts`, last, on an epic. Carried text shifted two levels never produces a `###` heading unless the specification has a `#` heading inside a numbered section, which this check catches.

## Size check (rule `body-size`)

Fill every placeholder with `#9999999` and count characters. The result must be under 65,536.
