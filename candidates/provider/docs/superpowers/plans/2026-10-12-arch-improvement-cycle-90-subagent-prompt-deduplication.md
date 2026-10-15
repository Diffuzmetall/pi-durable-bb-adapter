# Architecture Improvement Plan - Cycle 90: Subagent Prompt Deduplication

- **Cycle**: 90
- **Branch**: `feat/in-place-subagents`
- **Goal**: Eliminate redundant duplicate rendering of the subagent task prompt in the parent thread delegation card, keeping the card header/summary as the clean, single source of task truth, and ensuring nested events only stream actual subagent progress (thinking, tool execution, final response).
- **Architecture Context Map**:
  - Stage: prod / plugin harness
  - Source docs: `README.md`, `@earendil-works/pi-durable` documentation.
  - Active paths: `src/runner/bridge/bb-child-event-adapter.ts`, `src/host/tool-delta-translator.ts`, `tests/subagent-timeline-ordering.test.ts`.
  - Critical gates: AP-010 (Clean Architecture), AP-012 (State Machine & Boundaries), AP-019 (File size limits <200 runner, <250 host), AP-026 (Contracts & Schemas), AP-029 (TypeScript strictness).
  - Verification surface: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run doctor`, `bb plugin reload provider-pi-durable`.

---

## Triaged Findings (S5 Triage Gate)

| ID | Component | Severity | Rule | Decision | Description & Root Cause |
|---|---|---|---|---|---|
| **F-90-1** | `src/runner/bridge/bb-child-event-adapter.ts` | **P1** | AP-026 | `fix-now` | Duplicate prompt rendering in parent delegation card. `translateToolStart` already sets `summary: task` and `label: task` on the card. `BBChildEventAdapter` redundantly streamed `message_start` user input as an assistant `text_delta`, duplicating the prompt inside the card body. |
| **F-90-2** | `src/runner/session-commands.ts` | **P2** | AP-010, AP-034 | `log-only` | Parent abort does not cascade to background subagents. Retained as intended by Pi Durable background boundary invariants (`{ background: true }` isolation boundary) per explicit user confirmation. |
| **F-90-3** | `src/host/session.ts` | **P2** | AP-020, AP-034 | `log-only` | Host Bridge does not stop active BB subthreads on parent interrupt. Retained per user decision. |

---

## Task Breakdown

### Slice 1: Child Adapter Prompt Deduplication (F-90-1)
- **Boundary**: Runner Bridge (`src/runner/bridge/bb-child-event-adapter.ts`)
- **AP Gates**: AP-019 (<200 lines), AP-026, AP-029
- [ ] Update `tests/subagent-timeline-ordering.test.ts`:
  - Verify `BBChildEventAdapter` does NOT emit `user` `message_start` as an assistant `text_delta`.
  - Verify `BBChildEventAdapter` only streams genuine assistant output (`thinking_delta`, `assistant` `text_delta`) and tool events (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`) under `parentRef`.
  - Verify that the delegation card in `translateToolStart` remains the sole, clean container for `summary` and `label`.
- [ ] Update `src/runner/bridge/bb-child-event-adapter.ts`:
  - Remove redundant `message_start` user message handler.
  - Keep file strictly < 200 lines (AP-019).
- [ ] Run `node --test tests/subagent-timeline-ordering.test.ts` (Green).

### Slice 2: Full Verification, Ledger & Memory Update (S9–S12)
- **AP Gates**: AP-019, AP-022, AP-029
- [ ] Run `npx tsc --noEmit` (0 errors).
- [ ] Run full test suite: `npm test` (All tests green).
- [ ] Build runner and plugin: `npm run build`.
- [ ] Sync dist to BB plugin cache (`~/.bb/plugins/cache/.../dist/`) and reload plugin (`bb plugin reload provider-pi-durable`).
- [ ] Update `docs/arch-improvement/ledger.md` (Cycle 90).
- [ ] Update `docs/arch-improvement/memory.md` (Cycle 90 lessons).
- [ ] Provide terminal summary with ledger link.
