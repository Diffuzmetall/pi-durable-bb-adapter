# Arch Improvement Cycle 81 Plan: Pi Durable 1.1.0+ Native Parity & Technical Debt Retirement

## Goal
Systematically research, adopt, and migrate to native `@earendil-works/pi-durable@1.1.0` and `@earendil-works/pi-coding-agent@1.1.0` capabilities:
1. Retire hand-rolled nested tool execution shims in favor of native `parentToolCallId` and `executeTool`.
2. Connect native Photon WebAssembly image processor in `createCodingTools` for multimodal `read` support.
3. Streamline `BBEventAdapter` and `subagent-watcher` to consume first-party `parentToolCallId` and `parentTaskId` from native `AgentEvent`.
4. Keep the provider thin (AP-010), eliminate duplicate code, and ensure 100% deterministic test coverage.

## Architecture Context Map Reference
- Runner setup: `src/runner/harness-setup.ts`
- Runner extension mount: `src/runner/extension-mount.ts`
- Runner bridge: `src/runner/bridge/bb-event-adapter.ts`, `src/runner/subagent-watcher.ts`
- Host delta translator: `src/host/tool-delta-translator.ts`
- Tests: `tests/*.test.ts`

## Findings Selected for Fix-Now
- **F-81-1 (P1)**: Native `parentToolCallId` in `AgentEvent` not leveraged. (Upstream 1.1.0 now natively emits `parentToolCallId` and `parentTaskId` on `tool_execution_*` events; plugin can rely on it directly).
- **F-81-2 (P2)**: Missing native Photon image processor in `createCodingTools` (image reading in `read` tool is unconfigured).
- **F-81-3 (P2)**: Hand-rolled `createNestedToolExecutor` in `extension-mount.ts` replicates logic now covered by native `ToolTask` and `parent` hooks.
- **F-81-4 (P2)**: Deprecated `StorageRejected` / error handling cleanup after 1.1.0 storage contract changes.

---

## Tasks & Bounded Fix Slices

- [ ] **Task 1: Native Image Processor Integration (F-81-2)**
  - In `src/runner/harness-setup.ts`, load Photon WASM image processor from `@earendil-works/pi-durable/images/node` conditionally when available.
  - Configure `createCodingTools({ images: imageProcessor })` instead of unconfigured `CodingTools`.
  - Validate with existing and new tests.

- [ ] **Task 2: Native Event Parity for `parentToolCallId` (F-81-1)**
  - In `src/runner/bridge/tool-result-extractor.ts` and `src/runner/bridge/bb-event-adapter.ts`:
    Directly forward native `event.parentToolCallId` and `event.parentTaskId` when present on `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
  - In `src/host/tool-delta-translator.ts`:
    Ensure `parentRef` falls back to `event.parentToolCallId` seamlessly.

- [ ] **Task 3: Refactor Nested Tool Shims in Extension Mount (F-81-3)**
  - Simplify `createNestedToolExecutor` in `src/runner/extension-mount.ts` to cleanly align with `pi-coding-agent` 1.1.0 `AgentToolCallOutcome` and delegate to proper validation.
  - Ensure file size remains < 150 lines (AP-019).

- [ ] **Task 4: Verification, Deterministic Testing & Ledger Update**
  - Run `npx tsc --noEmit` and `npm test` across all suites.
  - Add regression tests verifying native image loader and native `parentToolCallId` event routing.
  - Update `docs/arch-improvement/ledger.md` with Cycle 81 audit and results.
