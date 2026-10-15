# Implementation Plan: Cycle 82 — MCP Extension & Codemode Tool Parity

**Date:** 2026-10-11  
**Cycle:** 82  
**Branch:** `feat/in-place-subagents`  
**Architecture Context:** `docs/architecture/pi-durable-mcp-parity.excalidraw` (C4 Container & Component Model)  
**AP Gates:** AP-010 (Thin Adapter), AP-013 (Contract Completeness), AP-019 (File Size < 200 lines), AP-026 (No Silent Fallbacks), AP-028 (Test Parity), AP-029 (TypeScript Strictness)

---

## 1. Goal

Restore full tool discovery, namespace inspection, and execution parity for MCP extensions (`telegram-mcp`, `gbrain`) and deferred tools inside `codemode` sandbox (QuickJS), while strictly isolating the model's token context via `callers: ["tools"]` to prevent prompt bloat. Eliminate ad-hoc dynamic fallbacks in favor of reactive lifecycle synchronization.

---

## 2. Triaged Findings (S4/S5)

| Finding ID | Severity | Description | Disposition |
|---|---|---|---|
| **F-82-1** | P0 | `TypeError: runtime.setActiveTools is not a function` on `session_start` | `fix-now` |
| **F-82-2** | P0 | Crash on `ctx.signal` due to missing `contextActions` in `setupExtensionRunner` | `fix-now` |
| **F-82-3** | P1 | `searchTools()` and `describeNamespace()` in `codemode` return empty due to stripped `namespace`/`exposure` metadata | `fix-now` |
| **F-82-4** | P1 | Token leakage: MCP tools without caller isolation blow up model context (~9k tokens) | `fix-now` |
| **F-82-5** | P1 | Ad-hoc `dynamic-fallback` hack in `createNestedToolExecutor` violates clean reactive registry design | `fix-now` |

---

## 3. Implementation Slices (S6)

### Slice 1: ExtensionActions Contract Completeness (`setActiveTools` & `contextActions`)
- **Boundary:** Infrastructure Adapter (`src/runner/extension-bridge.ts`)
- **AP Gates:** AP-010, AP-013, AP-029
- **Red Test:** `tests/codemode-mcp-parity.test.ts` fails when calling `runner.bindCore()` and inspecting `ctx.signal` or invoking `setActiveTools`.
- **Implementation:**
  1. Add `activeToolNames` tracking and `setActiveTools(tools: string[]): void` to `ExtensionActions` in `bindCore`.
  2. Implement full `ExtensionContextActions` in `setupExtensionRunner` (`getSignal`, `getModel`, `isIdle`, `abort`, `hasPendingMessages`, `getContextUsage`, `compact`).
- **Verification:** Unit test verifies `setActiveTools` updates active list and `ctx.signal` does not throw.

### Slice 2: Tool Metadata Enrichment (`namespace`, `exposure`) for QuickJS Codemode
- **Boundary:** Domain/Application Interface (`src/runner/extension-bridge.ts`, `extension-mount.ts`)
- **AP Gates:** AP-013, AP-028
- **Red Test:** `tests/codemode-mcp-parity.test.ts` fails when `searchTools("telegram", { namespace: "mcp__telegram" })` or `describeNamespace("mcp__telegram")` returns empty array/null.
- **Implementation:**
  1. In `getAllTools()` inside `bindCore`, preserve `namespace`, `exposure`, `promptGuidelines`, `annotations`, `sourceInfo` from the underlying `ToolDefinition`.
  2. In `getCallableTools()`, ensure extension-registered tools carry their qualified namespace and exposure tags.
- **Verification:** `searchTools` and `describeNamespace` inside QuickJS sandbox return matching tool definitions.

### Slice 3: Token Context Isolation via `callers: ["tools"]`
- **Boundary:** Domain Policy / Schema Mapping (`src/runner/extension-bridge.ts`)
- **AP Gates:** AP-010, AP-029
- **Red Test:** Test verifies that tools with `exposure: "codemode"` or `exposure: "deferred"` have `callers === ["tools"]`, while direct tools have `callers === ["model", "tools"]`.
- **Implementation:**
  1. In `adaptExtensionTool()`, map `toolDef.exposure`:
     - `"codemode"` or `"deferred"` $\to$ `callers: ["tools"]`.
     - `"direct"` or unspecified $\to$ `callers: ["model", "tools"]`.
  2. Ensure durable `Harness` skips prompt generation for `callers: ["tools"]`.
- **Verification:** Assert tool schema presence in `registry.tools` matches callers policy.

### Slice 4: Clean Tool Execution & Removal of Ad-hoc Dynamic Fallbacks
- **Boundary:** Infrastructure Adapter (`src/runner/extension-mount.ts`)
- **AP Gates:** AP-010, AP-026
- **Red Test:** Test verifies nested tool execution through `createNestedToolExecutor` works cleanly for both static and dynamically loaded MCP tools without fabricating synthetic fallbacks.
- **Implementation:**
  1. Subscribe `runner.onToolsChanged` to update the Durable `Registry` promptly.
  2. Ensure `createNestedToolExecutor` resolves from the registry cleanly.
- **Verification:** End-to-end execution of `tools.mcp__test__greet({ name: 'Vanya' })` inside `codemode` passes.

---

## 4. End-to-End Verification Gate (S9)

1. `npx tsc --noEmit` $\to$ Exit code 0, 0 type errors.
2. `npm test` $\to$ All test suites pass (151+ tests).
3. `npm run build` $\to$ Successful compilation of `dist/runner/index.js`, `dist/server.js`, `dist/host.js`.
4. `npm run doctor` $\to$ Healthy diagnostics report.
5. Synchronization to `~/.bb/plugins/cache/.../dist/` and `bb plugin reload provider-pi-durable`.

---

## 5. Ledger & Memory Update (S10/S11)

- Update `docs/arch-improvement/ledger.md` with final Cycle 82 report.
- Record key learning into `gbrain` memory regarding `callers: ["tools"]` token optimization in Pi Durable.
