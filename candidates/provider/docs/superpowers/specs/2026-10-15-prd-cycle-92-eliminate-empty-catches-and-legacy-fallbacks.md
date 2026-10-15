# PRD: Cycle 92 — Elimination of Empty Catches, Redundant Fallbacks, and Deprecated Compatibility Layers

## 1. Executive Summary & Intent
`bb-plugin-provider-pi-durable` has achieved full parity with `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, and `@earendil-works/pi-codemode@^1.2.0` (Cycle 91).
However, the codebase currently carries technical debt in the form of:
1. **Deprecated backward compatibility layers:** Legacy `.jsonl` directory checks and multi-version shims (e.g., dual return objects `{ output, content }` and fallback extractions `msg.output ?? msg.content`). Per project mandate: *no backward compatibility needed* — the plugin exclusively targets Pi Durable 1.2.0+ SQLite sessions and modern Beyond Boundaries IDE contracts.
2. **Silent/empty catches:** Catch blocks that swallow errors without logging or diagnostics, masking real failures and hindering debugging.
3. **Redundant defensive fallbacks:** Triple-nested fallbacks and dead code paths where schemas and TypeScript types already guarantee structure.

This cycle systematically cleanses these anti-patterns across `src/runner/` and `src/host/`, enforcing clean fail-fast semantics, lean adapter architecture (AP-010), and strict type invariants (AP-029).

---

## 2. Invariants & Non-Goals

### Invariants
1. **Durable 1.2.0 Modern Baseline (AP-010, AP-026):** All session directories are pure SQLite directories containing `session.sqlite`. No `.jsonl` legacy folder branches.
2. **Canonical Contract Parity (AP-013, AP-026):** Tool execution results use `output: Array<ContentBlock>`. No legacy `content` aliases.
3. **Actionable Error Visibility (AP-013, AP-028):** No swallowed exceptions. Any catch block must either rethrow, report to diagnostics/onNotice, or log with context (`[Component] Context: error`).
4. **File Line Budget (AP-019):** 100% of files in `src/runner/` remain strictly < 200 lines.
5. **Deterministic Verification (AP-028):** All unit and integration tests must pass cleanly (`npm test`).

### Non-Goals
- Changing the public BB provider RPC protocol.
- Modifying UI components or themes.

---

## 3. Targeted Refactoring Areas

### 3.1. Purging Legacy `.jsonl` Compatibility Branches
- **`src/runner/session-storage.ts`:**
  - Remove legacy directory detection:
    ```typescript
    // REMOVE:
    const legacyDir = `${directory}.jsonl`;
    const legEntries = await readdir(legacyDir);
    if (legEntries.includes("session.sqlite")) directory = legacyDir;
    ```
  - Remove stripping of `.jsonl` suffixes from custom session names. Target directories are directly resolved.
- **`src/host/thread-fork.ts`:**
  - Remove `.jsonl` legacy path resolution branches in `resolveSourceSessionDb`.
- **Tests:** Update `tests/cwd-isolation.test.ts` and `tests/thread-fork.test.ts` to reflect the pure SQLite directory contract without legacy `.jsonl` fallbacks.

### 3.2. Eliminating Dual `content` / `output` Shims
- **`src/runner/tool-adapter.ts`:**
  - Remove duplicate `content: blockContent` in execution results. Return strictly `{ output: sanitized, isError }`.
- **`src/runner/subagent.ts`:**
  - Remove legacy `content` aliases. Return strictly `{ output }`.
- **`src/runner/bridge/tool-result-extractor.ts`:**
  - Extract tool results directly from `msg.output` without `?? msg.content` fallback.

### 3.3. Auditing and Fixing Silent / Empty Catches
- **`src/runner/diagnostics.ts`:**
  - Ensure all probe and inspection catches log descriptive warnings or feed the diagnostics report rather than swallowing errors.
- **`src/runner/extension-mount.ts`:**
  - Clean up catch blocks to ensure errors during tool execution or extension startup are reported to `onNotice` or logged with context.
- **`src/runner/session-storage.ts`:**
  - Ensure lock cleanup and file removal catches explicitly log if an error is not `ENOENT`.

### 3.4. Pruning Redundant Fallbacks
- Remove superfluous null-coalescing chains where TypeScript non-null guarantees exist.
- Simplify `callers` mapping in `tool-adapter.ts`.

---

## 4. Verification Criteria
1. `npx tsc --noEmit` exits with 0 errors.
2. `npm test` passes all tests with 0 failures.
3. `wc -l $(find src/runner -maxdepth 1 -type f)` confirms 100% of files < 200 lines.
4. `npm run doctor` and `npm run build` succeed.
5. Independent Architecture Reviewer awards `VERDICT: PASS`.
