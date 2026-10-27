# Technical specification template

Copy this file to `specs/<n>-<short-name>.md` and fill it in, where `<n>` is the spec's place in the delivery order. It follows the structure of the PR Review Agent specification, a GitHub Action with persisted state that is kept outside this repository.

Lines starting with `> Guide:` explain what a section must contain. Delete them as you fill the section in. Text in `<angle brackets>` is a placeholder. Example rows come from the source specification; replace them.

## How to use this template

- **Describe the design, not its history.** The spec states the design as it stands. What changed between versions, and why, goes in the pull request that changes the spec, never in the spec.
- **Write for the implementer.** Someone with only this document and the repository should be able to build the component and know when it is done. Describe the design in the present tense ("`publish-review` reads the pull request again before it posts"), even before it exists.
- **Be specific.** Give numbers, names, limits, schema versions, key layouts and error names. "Bounded concurrency" is not a requirement; "a `Map` with a maximum concurrency of 2" is.
- **Keep the section order.** Sections 1 to 3 and 10 to 20 are fixed. Sections 4 to 9 are domain sections: rename them, merge them or add more, then renumber everything after them and fix cross-references.
- **Cross-reference with `§`.** Point to the section that owns a fact (`§7.1`) instead of repeating it. Each fact lives in one place.
- **Prefer tables for anything enumerable:** inputs, error codes, schemas, resources, permissions, tests, slices.
- **Mark optional sections.** Delete an optional section that does not apply, rather than leaving it empty.
- **Record every limitation.** Each accepted limitation in §18 either explains why it is acceptable or names the backlog slice that fixes it.
- **When code already exists, the code wins.** When retrofitting a spec to an implementation, describe what the repository does, record each decision in §1, and list known defects in §18 instead of specifying them as requirements.
- **Follow the prose rules** in `.agents/workflows/plain-language.md`. Use ASCII apart from `§`, no em dashes, code symbols in backticks, one paragraph per line.
- **Never include** credentials, account IDs, domains, email addresses, real user data, state or plans. This repository is public.

---

# <Component name>: Technical Specification

**Status:** <Draft | Specification for v1 delivery | Revised specification; feasibility gates pending>

**Version:** <1.0-draft>

**Date:** <Month D, YYYY>

**Component:** <workspace paths, such as `applications/<name>`, plus shared packages and infrastructure modules it owns or changes>

**Runtime:** <language, runtime and version, execution environment>

**Deployment:** <how and where it ships, such as "a container image published by a GitHub Actions release workflow">

**<Provider or key dependency>:** <the external service the design depends on, such as "the GitHub REST and GraphQL APIs through a GitHub App token">

**Persistent state:** <where durable state lives and who owns it>

**External dependencies at runtime:** <every network destination or managed service called at runtime>

**Out of scope:** <the features a reader might assume are included but are not>

<Two or three sentences: who uses this, what goes in, what comes out, and why it matters to the rest of the system.>

**Readiness (optional):** <What this specification authorizes next, which gates have not passed yet, and when contracts may freeze. Never claim a gate passed without evidence.>

---

## 1. Resolved requirement decisions

> Guide: one row per requirement that was ambiguous or contradictory, or that this spec decides differently from the request. These are product decisions. Do not claim a provider guarantees more than it does.

| Requirement | Decision | Reason |
| --- | --- | --- |
| <ambiguous or contradictory requirement> | <what this spec decides, concretely> | <why; name the risk or cost it avoids> |
| "Single-shot API calls" vs repository tools | One inference request per round and no model tool calls. Deterministic tools gather context first. | Bounds cost and behavior. The cost is lower recall on very large changes (§18). |

**Additional capabilities included:** <capabilities not asked for that the design adds, as one comma-separated sentence>.

## 2. Goals and non-goals

### 2.1 Goals

1. <A user-visible outcome, stated so it can be tested.>
2. <A durability, safety or cost property.>
3. <An operational property, such as isolated developer deployments.>

### 2.2 Non-goals

- <Something a reader could reasonably expect that is deliberately excluded, and where it lives instead, if anywhere.>
- <A guarantee the design does not make, such as exactly-once processing.>

## 3. Runtime architecture

```text
<trigger or caller>
  |
  v
<entry point>
  +-- <component A>   (<what it owns>)
  +-- <component B>   (<what it owns>)
  |
  v
<durable state or output>
```

> Guide: show every hop data takes, every durable store, and every external service. Use ASCII arrows.

**Ownership rules:** <Which module owns which state or side effect. Name the only modules allowed to call each SDK, the filesystem or the network.>

**Packaging:** <Workspaces, packages and entry points; where shared types live; how import boundaries are enforced.>

**Orchestration decision (optional):** <If a framework or runtime was considered and rejected, say which, why, and what would justify reintroducing it.>

### 3.1 Execution policy

- <The unit of work: one event is one execution, one item is one run.>
- <Concurrency limits.>
- <Idempotency and retry rules.>
- <What happens on failure, and what state survives it.>
- <What the system never does, such as overwrite evidence or execute untrusted code.>

## 4. <External interface>

> Guide: everything a caller or operator touches: inputs and outputs, addresses and routing, CLI flags, events. One table per surface.

### 4.1 Inputs

| Input | Type / default | Semantics |
| --- | --- | --- |
| `<name>` | <type>, <default or "required"> | <meaning, validation, where it may come from and where it may never come from> |

### 4.2 Outputs

<Every output, with its allowed values. State what outputs never contain.>

### 4.3 <Acceptance or validation rules> (optional)

| Check | Result code | Notes |
| --- | --- | --- |
| <condition> | `<CODE>` | <what is stored or reported> |

## 5. <State, storage and records>

> Guide: the durable layout and the rules that protect it. Include a key or file layout, the immutability rules, one row per persisted document with its schema version, and the version of every processing stage.

### 5.1 Layout

```text
<root>/{<id>}/
  <record>.json
  <child>/{<id>}/
    <artifact>
```

### 5.2 Rules

1. <Immutability or append-only rule.>
2. <Ordering rule, such as "the request record is written before the provider call".>
3. <Provenance rule, such as "every run records the commit and stage versions".>

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `<path>` | `<name>/v1` | `<module>` | <fields> |

### 5.4 Stage versions (optional)

| Key | v1 value |
| --- | --- |
| `<stage>Version` | `<value>` |

## 6. <Process or pipeline>

> Guide: the ordered steps of one unit of work, written as a numbered list a test can follow. Include retries, timeouts, concurrency and failure handling.

### 6.1 <Main flow>

1. <Step, with the module that performs it and what it writes.>
2. <Step.>

### 6.2 <Secondary flow, such as replay or incremental rounds>

### 6.3 Retries and failure

<Retry policy as numbers: interval, backoff, attempts, and the exact error names retried. What a retry does to identifiers and partial state.>

## 7. <Core algorithm or domain logic>

> Guide: the rules a reviewer will argue about. Write them precisely enough that two implementers would produce the same output. Use tables for thresholds and mappings.

| <Input condition> | <Result> |
| --- | --- |
| <rule> | <outcome> |

## 8. <Further domain section> (optional)

## 9. <Further domain section> (optional)

## 10. Typed domain model

### 10.1 Core types

> Guide: every type that crosses a module, process or persistence boundary. Name the package that exports it. Branded identifiers and readonly records where the language supports them.

```typescript
interface <Record> {
  <field>: <type>;
}

type <Union> = '<A>' | '<B>';
```

<Validation rules that types cannot express: which fields are validated at trust boundaries, which persisted types may never hold source or secret content.>

### 10.2 Relationships

```text
<Entity> 1 -> many <Entity>
<Entity> 0..1 -> <Entity>
```

## 11. Module and class catalog

> Guide: one row per public class or exported function. Constructor dependencies are injected; name the only files allowed to call SDKs, the filesystem or child processes.

### 11.1 <Group, such as entry points>

| Class or file | Public methods | Purpose |
| --- | --- | --- |
| `<Name>` (`<path>`) | `<method(args): Return>` | <one-sentence responsibility> |

### 11.2 <Group, such as pure libraries>

## 12. Directory structure and ownership

```text
<repo>/
  <path>/                 # <owner and purpose>
    <file>                # <purpose>
```

<Import rules between directories and how they are enforced.>

## 13. Configuration and infrastructure

> Guide: keep the subsections that apply. Configuration belongs here when users or operators set it; infrastructure belongs here when the component deploys cloud resources.

### 13.1 Configuration schema (optional)

```yaml
schemaVersion: 1
<section>:
  <key>: <default> # <meaning and bounds>
```

<Where the file is read from, which values may never come from it, and what invalid configuration does.>

### 13.2 Persistent resources (optional)

| Resource | Owner | Configuration |
| --- | --- | --- |
| <bucket, key, table> | <OpenTofu module> | <encryption, versioning, retention, lifecycle> |

### 13.3 Application resources (optional)

| Resource | Configuration |
| --- | --- |
| <function, state machine, queue> | <memory, timeout, concurrency, environment> |

### 13.4 Permissions (optional)

| Principal | <Resource A> | <Resource B> |
| --- | --- | --- |
| <role> | <actions> | <actions> |

### 13.5 Deployment

<Environments, who may deploy each, pre-deployment checks, post-deployment verification, approvals and rollback.>

## 14. Security and privacy

1. <Trust boundary: what is untrusted and how it is handled.>
2. <Where sensitive data lives and how it is protected.>
3. <What never appears in source control, logs or outputs.>
4. <What the system never executes or follows.>

## 15. Observability

- <Log format and levels.>
- <Metrics and traces.>
- <The audit record an operator uses to answer "what happened to this input".>

## 16. Testing, CI and release

### 16.1 Tests

| Layer or file | Covers |
| --- | --- |
| <unit tests> | <behaviors> |
| <integration or contract tests> | <behaviors> |
| <security tests> | <adversarial cases> |

<Coverage thresholds, and which files are exempt and why. State that tests never call live services.>

### 16.2 Evaluations (optional)

<Labeled corpora, metrics, sample sizes and the gates they feed. State what a passing result does and does not prove.>

### 16.3 CI and release

<What CI runs on each change, how versions and releases are produced, and what must pass before a release.>

### 16.4 Live validation (optional)

<The manual check an operator runs in a real environment before promoting.>

## 17. Acceptance criteria

> Guide: release gates written as observable outcomes. Each gate names the input and the expected evidence. Use checkboxes when the list tracks progress.

- [ ] <Given an input, the system produces an observable result.>
- [ ] <A failure case leaves the specified records and nothing else.>
- [ ] <Every test in §16.1 passes with the coverage thresholds.>

## 18. Risks and accepted limitations

1. **<Short name>:** <what can go wrong, under what input, and its effect. Then either why it is accepted or the slice that fixes it (P<n>.<m>).>
2. **<Short name>:** <...>

## 19. Reference documentation

- <Topic>: <URL that you have checked resolves>

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- File the whole plan with `/prism-spec-to-issues <spec-path> plan` (Codex: `$prism-spec-to-issues`). Use `file` to print the triaged tree and confirm before GitHub writes; use the saved external state to resume an interrupted filing. The plan has one root container, with phase epics underneath. Backlog is excluded when filing v1.
- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. Use `/prism-create-github-issue` for ad hoc issues outside a spec plan.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- A **split slice** keeps its original heading and all required slice fields, adds `- **Split into:** P0.2.1, P0.2.2`, and puts each child under a five-hash heading such as `##### P0.2.1 <Child title> (S)`. Each child has all slice fields, a stable ID extending its parent, and independently testable Acceptance bullets. One split level is supported.
- **Priority** is optional (`- **Priority:** P0|P1|P2|P3`), default P2. **Labels** is optional (`- **Labels:** enhancement, severity: none, area: repository`), with names from `.github/labels.json`. Without it, leaves use enhancement, severity: none, and package/area labels inferred from Files (area: repository when no package is named). Phase epics default to epic, severity: none, area: repository; the root defaults to severity: none, area: repository. Only the triager forms independence groups.
- **Blocked by** lists Plan IDs. Create native blocked-by links after every issue in the batch exists.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- An active slice cannot depend on an excluded Backlog slice. Resolve that scope in the spec before filing. Blocked-by entries name slices in this plan only; references to another spec need a resolved local delivery plan before filing.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| <shared type, schema, port or key layout> | P<n>.<m> | <modules or later specs> |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- <Code structure rules, such as injected dependencies and no SDK calls outside adapters.>
- <Test and coverage rules.>
- <The repository checks that must pass, from the `AGENTS.md` checks table.>
- <Version bump rule for behavior changes.>
- <Documentation rule for operator-visible changes.>
- <Data rule: no real credentials, user data or private source in fixtures.>

### Phase 0: <Foundation and contracts>

**Goal:** <what exists when the phase ends>.
**Exit criteria:** <observable conditions that close the epic>.

#### P0.1 <Slice title> (<XS|S|M>)

- **Blocked by:** <none | P<n>.<m>, ...>
- **Spec:** <§x, §y>
- **Files:** <paths the slice creates or changes>
- **Provides:** <the functions, types or resources later slices consume>
- **Acceptance:**
  - <Observable, testable criterion.>
  - <Failure or edge case criterion.>

#### P0.2 <Slice title> (<size>)

### Phase <n>: <Feasibility spike> (optional)

> Guide: use a spike when a contract depends on behavior nobody has measured. A spike records reproducible evidence, and production slices that depend on it are blocked until the evidence is accepted. Name go/no-go gates explicitly.

### Phase <last>: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P<n>.1 | <deferred or newly found work> | <size> | <§18 item it fixes, or why it waits> |

### 20.4 Dependency order and parallel lanes (optional)

<The critical path through the blocked-by graph, which slices can run in parallel, and the first milestone that gives real product feedback.>

## 21. Review findings acceptance map (optional)

> Guide: one row per open review finding. Each row maps the finding to the contract that answers it and the evidence that will prove it. Remove a row once its evidence has passed. A mapped finding is not evidence that its fix has passed.

| Finding or recommendation | Contract | Required evidence |
| --- | --- | --- |
| <finding> | <§ and contract change> | <slice and test that proves it> |
