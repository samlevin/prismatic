# Cycle fixture

This specification follows `.agents/spec-slicing.md` except for one rule: the two slices block each other, so pre-flight stops at `acyclic` and nothing is filed.

## 1. Scope

A parser and a printer for a small configuration format.

## 2. Delivery plan

**Definition of done:** §2.1

### Phase 0: Format tools

**Goal:** Read and write the configuration format.

**Exit criteria:** A file read and written back is byte-identical.

**Contracts:** §1, §2.1

#### P0.1 Parser · S

- **Blocked by:** P0.2
- **Spec:** §1
- **Files:** `src/parser.ts`
- **Provides:** A parser for the configuration format
- **Acceptance:**
  - Every valid file parses, and every invalid one fails with a line number.

#### P0.2 Printer · S

- **Blocked by:** P0.1
- **Spec:** §1
- **Files:** `src/printer.ts`
- **Provides:** A printer that writes the parsed form back
- **Acceptance:**
  - Printing a parsed file reproduces it byte for byte.

### 2.1 Definition of done

- `npm test` passes.
