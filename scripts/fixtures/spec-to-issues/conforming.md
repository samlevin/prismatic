# Fixture: Technical Specification

## 3. Runtime

Adapters call storage.

## 16. Tests

Use injected storage.

## 20. Delivery plan: phases and slices

### 20.1 How to file this plan

File active phases; exclude Backlog.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| Storage port | P0.1 | Adapter |

### 20.3 Definition of done for every slice

- Tests never call live services.
- Run the repository checks for the changed scope.

### Phase 0: Contracts

**Goal:** A storage port and independently testable adapters exist.
**Exit criteria:** All port and adapter tests pass.

#### P0.1 Define storage port (XS)

- **Blocked by:** none
- **Spec:** §3, §16
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** Storage port
- **Labels:** enhancement, severity: none, area: repository
- **Priority:** P1
- **Acceptance:**
  - Port types compile.
  - Existing APIs remain available.

#### P0.2 Build adapters (M)

- **Blocked by:** P0.1
- **Spec:** §3, §16
- **Files:** `src/adapters/`
- **Provides:** Read and write adapters
- **Split into:** P0.2.1, P0.2.2
- **Acceptance:**
  - Both adapters satisfy the storage port.

##### P0.2.1 Build read adapter (S)

- **Blocked by:** P0.1
- **Spec:** §3, §16
- **Files:** `src/adapters/read.ts`
- **Provides:** Reader
- **Acceptance:**
  - Stored values can be read.

##### P0.2.2 Build write adapter (S)

- **Blocked by:** P0.1
- **Spec:** §3, §16
- **Files:** `src/adapters/write.ts`
- **Provides:** Writer
- **Acceptance:**
  - New values can be written.

#### P0.3 Describe storage API (XS)

- **Blocked by:** none
- **Spec:** §3
- **Files:** `docs/storage.md`
- **Provides:** API documentation
- **Acceptance:**
  - Documentation matches the storage port.

### Phase 1: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P1.1 | Add cache | S | Deferred |

### 20.4 Dependency order and parallel lanes

Adapters follow the port. Documentation can be written alongside the port.
