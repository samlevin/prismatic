# State file

The state directory lives outside every repository checkout and worktree, so nothing in it can be committed:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/{{prefix}}spec-to-issues/<owner>-<repo>-<spec file name without .md>-<path hash>/
  state.json
  bodies/<KEY>.md   body with @@issue:KEY@@ placeholders
  sent/<KEY>.md     the filled body last sent to GitHub
```

`<path hash>` is the first 8 hex characters of the SHA-256 of the specification's absolute path (`printf '%s' /abs/spec.md | shasum -a 256 | cut -c1-8`), so two specifications with the same file name in different folders get separate directories. Refuse a state path inside a git working tree (`git -C <dir> rev-parse --is-inside-work-tree` prints `true`). The directory holds issue numbers and IDs, never tokens or credentials.

## state.json

```json
{
  "repository": "{{repository}}",
  "spec": "/absolute/path/to/spec.md",
  "specSha256": "<sha256 of the specification file>",
  "planSha256": "<sha256 of the bodies/ files concatenated in creation order>",
  "login": "<authenticated login>",
  "assignee": "<login or null>",
  "startedAt": "<ISO time, 5 minutes before the first create, whole seconds; or null>",
  "mismatch": false,
  "items": [
    {
      "key": "Plan",
      "kind": "container",
      "title": "Notes service delivery plan",
      "parent": null,
      "blockers": [],
      "labels": ["enhancement", "severity: none"],
      "priority": "P2",
      "size": "L",
      "predicted": null,
      "number": null,
      "id": null,
      "nodeId": null,
      "sentSha256": null,
      "parentLinked": false,
      "blockersLinked": [],
      "projectItemId": null,
      "fieldsSet": false,
      "triaged": false,
      "containersReconciled": false
    },
    {
      "key": "Phase 0",
      "kind": "epic",
      "title": "Foundation",
      "parent": "Plan",
      "blockers": [],
      "labels": ["epic", "severity: none"],
      "priority": "P2",
      "size": "L",
      "predicted": null,
      "number": null,
      "id": null,
      "nodeId": null,
      "sentSha256": null,
      "parentLinked": false,
      "blockersLinked": [],
      "projectItemId": null,
      "fieldsSet": false,
      "triaged": false,
      "containersReconciled": false
    }
  ]
}
```

`items` is in creation order: the root container keyed `Plan`, then epics, then containers, then leaves, each in specification order. `id` is the issue's REST `id` (sub-issue and dependency calls need it), `nodeId` its `node_id`. `blockersLinked` lists the blocker keys already linked. `containersReconciled` applies to the root and the epics only. The root's `parentLinked` stays `false` because it has no parent.

## Rules

- Write `state.json` after every successful GitHub write, before the next one. Write to a temporary file in the same directory and rename it over `state.json`, so an interruption never leaves half a file.
- Write `startedAt` before the first create, not after it. It sits 5 minutes early and in whole seconds so that clock skew or GitHub's one-second `created_at` cannot exclude the first issue from the resume lookup. The lookup's protection against duplicates comes from the title, the creator, and the stop on two matches, not from exact times.
- Record `number`, `id`, `nodeId`, and `sentSha256` from the create response before doing anything else.
- On start, if `state.json` exists, first compare its `spec` with the specification's absolute path. A different path is a different specification whose directory name happens to collide: stop and report both paths, and never resume, overwrite, or reuse that state for the new specification. Then compare `specSha256` with the specification. A different hash means the specification changed after filing began: stop and ask, because the plan the user confirmed is no longer the plan on disk.
- An item with a `number` is never created again. An item without one may still exist if an earlier run stopped between the create and the state write; the resume step in the skill finds it by title before creating anything.
