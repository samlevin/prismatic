# Independence groups

`ac-issue-triager` reads this file to form groups, the filing skills read it only when the triager returned groups, and `ac-implement` reads it to validate a container's record.

Only `ac-issue-triager` forms independence groups, for a new container or epic with two or more leaf children, and for a whole specification delivery plan when `ac-spec-to-issues` asks for plan-wide groups. Two leaves are independent when all of these hold:

- No chain of blocked-by edges links them in either direction, directly or through another leaf.
- They share no blocker that is still open, because both would stack on its unmerged PR.
- Their implementation notes name no overlapping files or shared contracts.

Every leaf in a group must be independent of every leaf in every other group. Leaves in one group may depend on each other.

The triager also recommends a blocked-by edge for every pair of leaves in a batch whose implementation notes overlap or where one uses the other's output, and forms groups after counting those edges. Two leaves linked by a planned or recommended edge therefore never sit in different groups.

## Record

When the triager returns groups, record them once the children exist by appending this section to the container's body, one line per group, with the leaves' issue numbers:

```markdown
### Independence groups

<!-- independence-groups -->
- g1: #101 #103
- g2: #102
<!-- /independence-groups -->
```

New records use the `gN:` form. Older records whose lines omit it, such as `- #101 #103`, still read: their lines number the groups g1, g2, and so on, in order.

Leave out the section when the triager returns no groups. Group membership never goes in labels.

### Plan-wide record

`ac-spec-to-issues` asks the triager to group every leaf of the plan at once, across phase epics, and appends that record, in the same format, to the plan's root container body. Its groups may hold leaves of different epics, including layers of a stack container. The epics then carry no record of their own.

## Reading the record

`ac-implement` reads only the lines between the markers, and only for the container that holds them. A record may name any leaf in that container's subtree: a direct leaf child, or a leaf under one of its epics or nested containers. It ignores the whole record, and treats the container as having none, when the section is malformed, names an issue outside that container's subtree or one that is not a leaf, lists an issue twice, or when leaves in different groups are now linked by a chain of blocked-by edges or share a blocker that is still open. Each record is read on its own, so an ignored root record leaves an epic's valid record in force, and the reverse.

A leaf may sit in groups of more than one valid record, such as its epic's and the root's. Two leaves are in different groups when a valid record puts them in different groups and no valid record puts them in the same group. A valid record makes leaves eligible for the queue's parallel exception; delivery stays sequential unless a person explicitly asks for parallel delivery. For leaves of different phase epics, that request names the plan's root container.
