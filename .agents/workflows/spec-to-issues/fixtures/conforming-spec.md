# Notes service specification

A small specification written to `.agents/spec-slicing.md`. It files as a root container, three epics under it, one stack container, and eight leaves, and passes every pre-flight rule.

## 1. Decisions

Notes are plain text with a title. The service stores them locally first and syncs later (§8). Storage details are in §6; the first storage slice is P1.1a.

### 1.1 Scope

One user, one device, and a local store. Sync between devices is deferred to Phase 2.

### 1.2 Non-goals

No rich text, no sharing, and no server-side search.

## 2. Architecture

The service is a library with injected ports. Only the storage adapter touches the file system. Types come from §4 and configuration from §5.

## 3. Directory layout

```text
package.json
src/domain/
src/config/
src/storage/
src/sync/
```

## 4. Domain types

### 4.1 Note

```typescript
type Note = { id: NoteId; title: string; body: string; updatedAt: string };
```

`NoteId` is a validated branded string. A note's display name comes from the configured title template, which defaults to `<title> - <date>`.

## 5. Configuration

The configuration file sets the store directory and the title template. Unknown keys fail validation, and a store directory outside the user's home fails too (§1.1).

## 6. Storage

### 6.1 Write path

Writes go to a temporary file and are renamed into place, so a crash never leaves half a note.

### 6.2 Read path

Reads validate every note against the §4.1 schema and skip notes that fail, reporting them.

## 7. Class catalog

| Class (`file`) | Public methods | Purpose |
| --- | --- | --- |
| `NoteId` (`domain/ids.ts`) | `parse(raw)` | Validates and brands note identifiers. |
| `Note` (`domain/note.ts`) | `create(input)` | Builds a validated note. |
| `ConfigLoader` (`config/loader.ts`) | `load(path)` | Reads and validates the configuration file. |
| `NoteWriter` (`storage/writer.ts`) | `put(note)` | Atomic writes (§6.1). |
| `NoteReader` (`storage/reader.ts`) | `get(id)`, `list()` | Validated reads (§6.2). |
| `NoteIndex` (`storage/index.ts`) | `search(text)` | Title search over stored notes. |
| `SyncClient` (`sync/client.ts`) | `push()`, `pull()` | Device sync (§8). |

## 8. Sync

Sync pushes and pulls notes through a remote folder. Conflicts keep both copies and report them. This work waits until local storage ships.

## 9. Delivery plan

**Definition of done:** §9.1

**Class catalog:** §7

### Phase 0: Foundation

**Goal:** A buildable package with validated domain types and configuration.

**Exit criteria:** The package builds, the §4 types validate, and P0.3 loads a sample configuration.

**Contracts:** §1, §2, §7, §9.1, §9.2

#### P0.1 Package scaffold · S

- **Blocked by:** none
- **Spec:** §3
- **Owns:** §3
- **Files:** `package.json`, `tsconfig.json`
- **Provides:** A buildable package with the directory layout of §3
- **Area:** repository
- **Acceptance:**
  - `npm run build` and `npm test` pass on an empty source tree.
  - The directories in §3 exist.

#### P0.2 Domain types · M

- **Blocked by:** P0.1
- **Spec:** §4, §1.1
- **Owns:** §4
- **Files:** `src/domain/{ids,note}.ts`
- **Provides:** Validated `Note` and `NoteId` types
- **Risk:** data-contract
- **Acceptance:**
  - `NoteId.parse` rejects empty and non-printable identifiers.
  - A `Note` round-trips through JSON unchanged.

#### P0.3 Configuration loader · S

- **Blocked by:** P0.2
- **Spec:** §5
- **Owns:** §5
- **Files:** `src/config/loader.ts`
- **Provides:** A loader that validates the configuration file
- **Risk:** security
- **Acceptance:**
  - Unknown keys fail with the key named.
  - A store directory outside the home directory fails.

### Phase 1: Storage

**Goal:** Notes persist locally and can be found by title.

**Exit criteria:** Notes written by P1.1a survive a crash and P1.2 finds them by title.

**Contracts:** §6

#### P1.1a Note store write path · S

- **Blocked by:** P0.2, P0.3
- **Spec:** §6.1
- **Files:** `src/storage/writer.ts`
- **Provides:** Atomic note writes
- **Stack:** Note store
- **Acceptance:**
  - A write interrupted before the rename leaves the previous note intact.

#### P1.1b Note store read path · S

- **Blocked by:** P1.1a
- **Spec:** §6.2
- **Files:** `src/storage/reader.ts`
- **Provides:** Validated note reads on top of the write path
- **Stack:** Note store
- **Acceptance:**
  - A note that fails the §4.1 schema is skipped and reported.

#### P1.2 Note index · M

- **Blocked by:** P1.1b
- **Spec:** §6
- **Files:** `src/storage/index.ts`
- **Provides:** Title search over stored notes
- **Notes:** Keep the index in memory; P2.1 rebuilds it after a pull.
- **Acceptance:**
  - Searching for a title prefix returns matching notes, newest first.
- **Validation:**
  - A benchmark with 10,000 notes answers a search in under 50 ms.

### Phase 2: Sync backlog

**Goal:** Device sync, filed now so the work survives outside this specification.

**Exit criteria:** Two devices converge after a push and a pull, and conflicts are reported.

**Contracts:** §8

**Deferred until:** P1.2

| Plan ID | Title | Size | Blocked by | Provides | Acceptance | Files |
| --- | --- | --- | --- | --- | --- | --- |
| P2.1 | Sync client | M | P1.2 | Push and pull through a remote folder | Two devices converge after a push and a pull<br>No note is lost when the network drops mid-push | `src/sync/client.ts` |
| P2.2 | Conflict report | S | P2.1 | A report of notes edited on two devices | Both copies of a conflicting note are kept and listed | `src/sync/conflicts.ts` |

### 9.1 Definition of done

- `npm run build` and `npm test` pass, with no network access in tests.
- Public contract changes update the matching `docs/` page and follow §2.

### 9.2 Dependency order

P0.1 -> P0.2 -> P0.3 -> P1.1a -> P1.1b -> P1.2. Phase 2 starts after P1.2.
