# Implementation Plan: Cycle 84 — Full Architecture Hardening & Parity

**Date:** 2026-10-11  
**Cycle:** 84  
**Branch:** `feat/in-place-subagents`  
**Architecture Context:** `docs/architecture/pi-durable-mcp-parity.excalidraw` (C4 Container & Component Model)  
**AP Gates:** AP-010 (Thin Adapter / Territory Ownership), AP-013 (Contract Completeness), AP-019 (File Size < 200 lines), AP-026 (No Silent Fallbacks), AP-028 (Test Parity), AP-029 (TypeScript Strictness)

---

## 1. Goal

Eliminate all remaining architectural flaws, contract omissions, file size violations (AP-019), and quarantined legacy code across `bb-plugin-provider-pi-durable`:
1. Provide a 100% complete, type-safe implementation of `ExtensionActions` and `ExtensionContextActions` without `as unknown as` escape hatches.
2. Make system prompt tool guidelines dynamic so extension and custom tools have their `promptGuidelines` rendered in `<rules>` and `<tools>`.
3. Eliminate the quarantined `src/runner/upstream/` directory by promoting session storage to `src/runner/session-storage.ts`.
4. Ensure all runner modules strictly adhere to AP-019 (< 200 lines per file) and remove unsafe `as never` casts.

---

## 2. Triaged Findings (S4/S5)

| Finding ID | Severity | Description | Disposition |
|---|---|---|---|
| **F-84-1** | P1 | Incomplete `ExtensionActions` contract in `setupExtensionRunner` (`sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel` missing, masked by `as unknown as`) | `fix-now` |
| **F-84-2** | P1 | `src/runner/prompt.ts` hardcodes `CANONICAL_TOOL_DEFS` and is blind to extension tool `promptGuidelines` in `<rules>` and `<tools>` | `fix-now` |
| **F-84-3** | P2 | Quarantined legacy file `src/runner/upstream/session-storage.ts` (205 lines) from Pi v0.90 | `fix-now` |
| **F-84-4** | P2 | AP-019 file size violations: `extension-bridge.ts` (259 lines), `prompt.ts` (208 lines), `extension-mount.ts` (216 lines) | `fix-now` |
| **F-84-5** | P3 | Unsafe `as never` casts in `src/runner/extension-mount.ts:60` | `fix-now` |

---

## 3. Implementation Slices (S6)

### Slice 1: Contract Completeness for `ExtensionActions` & `ExtensionContextActions` (F-84-1)
- **Boundary:** Infrastructure Adapter (`src/runner/extension-bridge.ts`)
- **AP Gates:** AP-013, AP-029
- **Red Test:** Add unit test in `tests/codemode-mcp-parity.test.ts` verifying that `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, and `setLabel` exist on `runner` actions, can be called without error, and that `bindCore` no longer uses `as unknown as ExtensionActions`.
- **Implementation:**
  - Implement all missing methods in `actions` and `contextActions` with type safety.
  - Remove all `as unknown as ExtensionActions` and `as unknown as ExtensionContextActions` assertions.
- **Verification:** Unit test passes; `npx tsc --noEmit` verifies strict contract compliance.

### Slice 2: Dynamic System Prompt Tool Guidelines (F-84-2)
- **Boundary:** Domain/Application Interface (`src/runner/prompt.ts`)
- **AP Gates:** AP-010, AP-013, AP-028
- **Red Test:** In `tests/prompt-adapter.test.ts`, register a tool with custom `promptGuidelines` not in `CANONICAL_TOOL_DEFS` and verify that the guidelines are rendered in the generated `<rules>` section.
- **Implementation:**
  - Update `buildRules` and `visibleTools` to inspect definitions from `input.agent.tools` and `options.resourceLoader` instead of only hardcoded `CANONICAL_TOOL_DEFS`.
- **Verification:** Prompt tests pass and verify inclusion of dynamic tool rules.

### Slice 3: Promotion of `session-storage.ts` and Removal of `upstream/` (F-84-3)
- **Boundary:** Domain & Infrastructure Storage (`src/runner/session-storage.ts`)
- **AP Gates:** AP-010 (Decoupling), AP-019
- **Red Test:** Tests expecting `src/runner/upstream/session-storage.ts` fail when the path is retired until updated.
- **Implementation:**
  - Move `src/runner/upstream/session-storage.ts` to `src/runner/session-storage.ts`.
  - Update all imports in `src/runner/runtime-loader.ts`, `src/runner/runtime.ts`, `src/runner/extension-mount.ts`, `src/runner/diagnostics.ts`, and test suites.
  - Delete `src/runner/upstream/` directory.
- **Verification:** All tests in `tests/cwd-isolation.test.ts` and `tests/session-lock-eviction.test.ts` pass cleanly.

### Slice 4: AP-019 Line Length Compliance & Type Cleanliness (F-84-4, F-84-5)
- **Boundary:** Code Structure & Modularity (`src/runner/`)
- **AP Gates:** AP-019 (< 200 lines per file), AP-029
- **Implementation:**
  - Split tool adaptation helpers from `extension-bridge.ts` into `src/runner/tool-adapter.ts` so `extension-bridge.ts` is < 150 lines and `tool-adapter.ts` is < 130 lines.
  - Clean up `prompt.ts` so it is < 190 lines.
  - Clean up `extension-mount.ts` so it is < 190 lines, and replace `as never` with proper typed execution.
- **Verification:** Check `wc -l` on all modified files to ensure all are strictly < 200 lines.

---

## 4. Verification Gate (S9)

1. `npx tsc --noEmit` $\to$ Exit code 0, 0 type errors.
2. `npm test` $\to$ All test suites pass (153+ tests).
3. `npm run build` $\to$ Successful compilation.
4. `npm run doctor` $\to$ Clean diagnostics report.
5. `wc -l` check confirms all module files in `src/runner/` are < 200 lines.
6. Synchronize dist to BB cache and reload plugin.

---

## 5. Ledger & Memory Update (S10/S11)

- Update `docs/arch-improvement/ledger.md` with Cycle 84.
- Save durable knowledge into `gbrain` memory.
