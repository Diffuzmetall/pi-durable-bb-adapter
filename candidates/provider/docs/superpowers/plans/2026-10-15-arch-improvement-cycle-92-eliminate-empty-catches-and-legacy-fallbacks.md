# Implementation Plan: Cycle 92 — Elimination of Empty Catches, Redundant Fallbacks, and Deprecated Compatibility Layers

**Parent PRD:** `docs/superpowers/specs/2026-10-15-prd-cycle-92-eliminate-empty-catches-and-legacy-fallbacks.md`  
**Architecture Rules Enforced:** AP-010, AP-013, AP-019, AP-026, AP-028, AP-029.

---

## Proposed Changes

### Task 1: Purge Legacy `.jsonl` Compatibility Branches
- **`src/runner/session-storage.ts`:**
  - Remove `.jsonl` suffix slicing and legacy directory readdir inspection (`legacyDir = directory + ".jsonl"`).
  - Keep `clean.endsWith(".sqlite") ? resolve(clean, "..") : ...`.
- **`src/host/thread-fork.ts`:**
  - Remove `else if (sourceDir.endsWith(".jsonl"))` and `legacyDir = sourceDir + ".jsonl"`.
- **Tests (`tests/cwd-isolation.test.ts`, `tests/thread-fork.test.ts`):**
  - Clean up tests that asserted legacy `.jsonl` directory fallback behavior.
  - Verify with `npm test`.

### Task 2: Eliminate Dual `content` / `output` Shims
- **`src/runner/tool-adapter.ts`:**
  - Remove duplicate `content:` property in `execute` returns (lines 86-90, 130-136). Return strictly `{ output, isError }`.
- **`src/runner/subagent.ts`:**
  - Return strictly `{ output: [...] }`.
- **`src/runner/bridge/tool-result-extractor.ts`:**
  - In `extractToolExecutionResult`, extract directly from `msg.output` without `?? msg.content`.
- **Tests:**
  - Update any test assertions expecting `.content` on adapted tools to assert `.output`.

### Task 3: Audit and Cleanse Silent / Empty Catches
- **`src/runner/diagnostics.ts`:**
  - Audit all `try/catch` blocks. Replace any unlogged catches with explicit `console.warn` or diagnostics warnings.
- **`src/runner/session-storage.ts`:**
  - Verify that `logUnexpectedErr` properly handles non-ENOENT exceptions and doesn't swallow unexpected errors.
- **`src/runner/extension-mount.ts`:**
  - Clean up `.catch()` handlers on lifecycle emits to ensure context is logged.

### Task 4: Prune Redundant Fallbacks and Dead Checks
- **`src/runner/prompt.ts`:**
  - Prune redundant array check fallbacks (`Array.isArray(res) ? res : res?.skills ?? []`).
- **`src/runner/tool-adapter.ts`:**
  - Simplify type assertions and redundant casts.

### Task 5: Full Verification, Doctor, Build, and Review Gate
- Run `npx tsc --noEmit`.
- Run full `npm test`.
- Verify AP-019 line budgets: `wc -l $(find src/runner -maxdepth 1 -type f)` strictly < 200 lines.
- Run `npm run doctor` and `npm run build`.
- Commit changes to `main`.
- Trigger independent Architecture Reviewer subagent for audit and `VERDICT: PASS`.
