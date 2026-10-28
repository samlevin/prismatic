# Independence groups

`prism-issue-triager` reads this file to form groups, the filing skills read it only when the triager returned groups, and `prism-implement` reads it to validate a container's record.

Only `prism-issue-triager` forms independence groups, for a new container or epic with two or more leaf children. Two leaves are independent when all of these hold:

- No chain of blocked-by edges links them in either direction, directly or through another leaf.
- They share no blocker that is still open, because both would stack on its unmerged PR.
- Their implementation notes name no overlapping files or shared contracts.

Every leaf in a group must be independent of every leaf in every other group. Leaves in one group may depend on each other.

The triager also recommends a blocked-by edge for every pair of leaves in a batch whose implementation notes overlap or where one uses the other's output, and forms groups after counting those edges. Two leaves linked by a planned or recommended edge therefore never sit in different groups.

## Record

When the triager returns groups, record them once the children exist by appending this section to the container's body, one line per group, with the leaves' issue numbers:

```markdown
### Independence groups

<!-- prism-independence-groups -->
- g1: #101 #103
- g2: #102
<!-- /prism-independence-groups -->
```

New records use the `gN:` form. Older records whose lines omit it, such as `- #101 #103`, still read: their lines number the groups g1, g2, and so on, in order.

Leave out the section when the triager returns no groups. Group membership never goes in labels.

## Reading the record

`prism-implement` reads only the lines between the markers, and only for the container that holds them. It ignores the whole record, and treats the container as having none, when the section is malformed, names an issue that is not a direct sub-issue of that container, lists an issue twice, or when leaves in different groups are now linked by a chain of blocked-by edges or share a blocker that is still open. A valid record makes leaves eligible for the queue's parallel exception; delivery stays sequential unless a person explicitly asks for parallel delivery.
