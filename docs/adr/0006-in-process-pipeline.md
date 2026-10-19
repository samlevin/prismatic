# ADR 0006: A typed in-process pipeline instead of LangGraph

Status: accepted

## Context

The v1.0 draft of the design required a LangGraph.js `StateGraph` as the directed graph for each review run. A run fetches the base and configuration, loads state from the pull request, plans the review range, collects context, reserves budget, calls the model once, validates the findings, persists a record, and publishes. Each step runs once, in a fixed order, inside one Action run.

## Decision

`ReviewPipeline` in `src/pipeline/` runs the steps as a typed sequence in one process, holding its state in memory. It replaces the LangGraph.js graph, and the package depends on no LangGraph or LangChain package.

The reasons:

- Every step is deterministic. There are no tool loops and no conditional model re-entry, so nothing needs a graph runtime to decide what runs next.
- GitHub holds the only persistent state, in pull request comments. A graph runtime would add a second state representation and checkpoint semantics that the product would then have to forbid.
- The graph would add a dependency without removing any code. Each step still needs its own implementation and tests.

## Conditions for reintroducing a graph runtime

Bringing LangGraph, or any graph runtime, back requires all of the following:

- A new ADR that supersedes this one and names the requirement the typed pipeline cannot meet.
- A narrowly scoped runtime adapter behind the same step interface `ReviewPipeline` uses, so steps do not change.
- A test that executes the graph and checks it runs the same steps in the same order as the typed pipeline.

A graph runtime must never persist checkpoints, and must never become a second authoritative store of review state. The pull request comments that `PRStateRepository` reads and writes stay the only durable state.

## Consequences

- `package.json` lists no LangGraph dependency. `tooling/packageManifest.test.ts` fails if one appears.
- Step order and state are ordinary TypeScript, so the type checker and unit tests cover them.
- Parallel or conditional steps, if the product ever needs them, are written in TypeScript inside the pipeline or justified by a new ADR.
