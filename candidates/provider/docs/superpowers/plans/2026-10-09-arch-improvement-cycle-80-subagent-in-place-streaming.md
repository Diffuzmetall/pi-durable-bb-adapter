# Arch Improvement Cycle 80 Plan: Native Pi Durable In-Place Subagent Observability

## Goal
Implement end-to-end native subagent event multiplexing and in-place streaming for `@earendil-works/pi-durable` within BB IDE:
1. Dynamically discover child conversations spawned by `subagent` tools via `tool_execution_update` details.
2. Stream subagent reasoning and tool executions into the parent wire decorated with `parentRef`.
3. Translate `parentRef` in host delta translators to `key.parentRef` and `item.parentToolCallId`, validating with BB `threadDeltaSchema`.
4. Guarantee multi-level nesting and clean stream teardown while maintaining single-database ACID guarantees.

## Architecture Context Map Reference
- Runner multiplexer: `src/runner/subagent-watcher.ts`
- Child event adapter: `src/runner/bridge/bb-child-event-adapter.ts`
- Wire DTO contracts: `src/runner/bridge/contracts.ts`, `tool-result-extractor.ts`
- Host delta translators: `src/host/tool-delta-translator.ts`, `src/host/message-delta-translator.ts`, `src/host/delta-translator.ts`
- BB server protocol: `@get-bb/plugin-sdk/provider-bridge` (`threadDeltaSchema`)

## Findings Selected for Fix-Now
- **F-80-1 (P1)**: Runner conversation blind spot (only root stream was watched).
- **F-80-2 (P1)**: Missing `parentRef` / `parentToolCallId` propagation in wire DTOs and thread deltas.
- **F-80-3 (P2)**: Concurrency & state isolation for subagent thinking / text generation.
- **F-80-4 (P2)**: Missing deterministic integration test suite for subagent multiplexing.

---

## Tasks & Bounded Fix Slices

- [ ] **Task 1: DTO & Extractor Enhancements (F-80-2)**
  - Ensure `contracts.ts` includes `parentRef?: string` on tool start, update, end, message update, and message end events.
  - Ensure `tool-result-extractor.ts` extracts `details` on `tool_execution_update` and propagates `parentRef`.
  - Validate with existing test suite.

- [ ] **Task 2: Child Event Adapter & Parent Factory (F-80-3)**
  - Implement `BBChildEventAdapter` in `src/runner/bridge/bb-child-event-adapter.ts` (< 150 lines, AP-019).
  - Prefix child toolCallIds (`${parentRef}:${event.toolCallId}`) to eliminate collisions.
  - Swallow child-scoped lifecycle events (`turn_start`, `turn_end`, `run_end`).
  - Wire `createChildAdapter(parentCallId)` into `BBEventAdapter`.

- [ ] **Task 3: Host Delta Translators Propagation (F-80-2)**
  - Update `translateToolStart`, `translateToolUpdate`, `translateToolEnd` to attach `key.parentRef` and `item.parentToolCallId`.
  - Update `translateMessageUpdate` in `message-delta-translator.ts` to attach `key.parentRef` and `item.parentToolCallId` for subagent reasoning.
  - Wire `parentRef` in `delta-translator.ts`.

- [ ] **Task 4: Dynamic Subagent Watcher in Runner (F-80-1)**
  - Implement `startSubagentWatcher` in `src/runner/subagent-watcher.ts` (< 150 lines, AP-019).
  - Wire recursive attachment on `tool_execution_update` / `tool_execution_end` where `details.conversationId` is present.
  - Integrate into `src/runner/index.ts` with graceful cleanup on shutdown.

- [ ] **Task 5: Deterministic TDD Test Suite (F-80-4)**
  - Create `tests/subagent-in-place-streaming.test.ts`.
  - Test 1: Child event adapter decorates events with `parentRef` and prefixes `toolCallId`.
  - Test 2: Host delta translator produces strictly valid `threadDeltaSchema` deltas for child tools and reasoning.
  - Test 3: End-to-end subagent stream multiplexing simulated with native durable harness.

- [ ] **Task 6: Verification, Ledger & Learn Gate**
  - Verify with `npx tsc --noEmit` and `npm test` (all tests passing).
  - Check file line limits (< 200 lines, AP-019).
  - Update `docs/arch-improvement/ledger.md` with Cycle 80 findings and verification evidence.
