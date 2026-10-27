# Invalid fixture: Technical Specification

## 3. Runtime

Storage.

## 20. Delivery plan: phases and slices

### 20.1 How to file this plan

File active phases.

### 20.2 Seam contracts

None.

### 20.3 Definition of done for every slice

- Tests never call live services.

### Phase 0: Invalid contracts

**Goal:** Contracts exist.

#### P0.1 Duplicate contract (L)

- **Blocked by:** P0.2, P9.9
- **Spec:** §3
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** Contract
- **Labels:** missing label
- **Acceptance:**
  - Types compile.

#### P0.2 Duplicate contract (S)

- **Blocked by:** P0.1
- **Spec:** §3
- **Files:** `src/second.ts`
- **Acceptance:**
  - Types compile.

#### P0.1 Another contract (XS)

- **Blocked by:** none
- **Spec:** §3
- **Files:** `src/third.ts`
- **Provides:** Another contract
- **Acceptance:**
  - Types compile.
