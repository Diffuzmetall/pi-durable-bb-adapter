# Arch Improvement Plan: Cycle 62 — Host Modularity & Bridge Type Safety

**Scope:** `bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Prior Cycle:** Cycle 61 (`v0.3.0`, commit `a94ff7c`)

---

## 1. Findings Addressed from Cycle 61 Audit

| Finding | Target File(s) | Severity | Rule | Resolution Plan |
|---|---|---|---|---|
| **F-62-1** | `src/host/delta-translator.ts`, `bridge.ts`, `runner-process.ts`, `session.ts` | **P2** | **AP-019 (<200 lines per file):** 4 files in `src/host/` exceed the 200-line modularity threshold (202 – 226 lines). | Decompose into focused single-responsibility modules: `message-delta-translator.ts`, `runner-rpc-channel.ts`, `session-telemetry.ts`, `bridge-router.ts`. |
| **F-62-2** | `src/runner/bridge/` (`tool-args-resolver.ts`, `assistant-message-builder.ts`, `bb-event-adapter.ts`) | **P2** | **AP-029 (Zero `as any` / Strict TypeScript):** 12 `as any` escape hatches reading internal Durable SQLite documents. | Define typed interfaces and type-guards in `contracts.ts` to cleanly read Durable document structures. |
| **F-62-3** | `src/runner/model-setup.ts` | **P3** | **AP-011 (Low Coupling):** Unnecessary import of `getAgentDir` from `./upstream/session-storage.ts` when `@earendil-works/pi-coding-agent` exports it canonically. | Switch import to canonical `@earendil-works/pi-coding-agent`. |
| **F-62-4** | `docs/arch-improvement/ledger.md` | **P3** | **AP-028 (Documentation Integrity):** Ledger referenced `tests/context-telemetry.test.ts` instead of `tests/context-window-usage.test.ts`. | Correct filename reference in ledger. |

---

## 2. Implementation Slices

### Slice 1: Host Layer AP-019 De-bloating
1. **`src/host/delta-translator.ts` (226 -> <140 lines):**
   - Extract text chunk and thought translation helpers into `src/host/message-delta-translator.ts`.
2. **`src/host/runner-process.ts` (211 -> <140 lines):**
   - Extract line buffering and promise request matching into `src/host/runner-rpc-channel.ts`.
3. **`src/host/session.ts` (202 -> <140 lines):**
   - Extract session telemetry extraction and model resolution into `src/host/session-telemetry.ts`.
4. **`src/host/bridge.ts` (212 -> <140 lines):**
   - Extract turn/steer and thread/stop handler logic into `src/host/bridge-router.ts`.

### Slice 2: Durable Document Schema & Type Guards (AP-029)
1. In `src/runner/bridge/contracts.ts`:
   - Declare types: `AgentDocument`, `UsageDocument`, `ToolArgumentsDocument`.
   - Add type guards: `isAgentDocument`, `isUsageDocument`.
2. Update `tool-args-resolver.ts`, `assistant-message-builder.ts`, and `bb-event-adapter.ts` to use type guards instead of `as any`.
3. Verify zero `as any` in `src/runner/bridge/`.

### Slice 3: Upstream Dependency Cleanup & Ledger Fix
1. In `src/runner/model-setup.ts`:
   - Change `import { getAgentDir } from "./upstream/session-storage.ts"` to `import { getAgentDir } from "@earendil-works/pi-coding-agent"`.
2. In `docs/arch-improvement/ledger.md`:
   - Fix test filename in Cycle 60/61 entries.

### Slice 4: Verification, Version Bump & Release
1. Run full test suite: `npm test` (all passing).
2. Build bundles: `node scripts/build-runner.mjs && bb plugin build`.
3. Verify line counts: all `.ts` files in `src/` strictly < 200 lines.
4. Record Cycle 62 in `docs/arch-improvement/ledger.md`.
5. Bump version to `0.3.1` in `package.json`.
6. Commit & tag: `feat(arch): host modularity and bridge type safety (cycle 62, v0.3.1)` and tag `v0.3.1`.
7. Reload plugin: `bb plugin reload provider-pi-durable`.
