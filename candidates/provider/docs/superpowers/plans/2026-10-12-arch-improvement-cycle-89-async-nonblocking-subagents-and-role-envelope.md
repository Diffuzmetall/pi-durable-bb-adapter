# Architecture Improvement Plan - Cycle 89: Async Non-Blocking Subagents & Role Envelope

- **Cycle**: 89
- **Branch**: `feat/in-place-subagents`
- **Goal**: Implement non-blocking asynchronous subagent execution by default, inject explicit Role Envelopes into child conversations to prevent meta-discovery loops, remove artificial nesting restrictions, and seamlessly orchestrate Beyond Boundaries sidebar subthreads.
- **Architecture Context Map**:
  - Stage: prod / plugin harness
  - Source docs: `README.md`, `@earendil-works/pi-durable` documentation & examples (`22-subagent-foreground`, `23-subagent-background`, `24-child-tasks`).
  - Active paths: `src/runner/subagent.ts`, `src/runner/bridge/tool-result-extractor.ts`, `src/host/tool-delta-translator.ts`, `src/host/subthread-spawner.ts`, `src/host/session.ts`.
  - Critical gates: AP-010 (Clean Architecture), AP-012 (State Machines & Boundaries), AP-019 (File size limits: runner < 200, host < 250), AP-020 (Decoupling), AP-022 (No silent catches), AP-026 (Contracts & Schemas), AP-029 (TypeScript strictness), AP-034 (Concurrency discipline).
  - Verification surface: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run doctor`, `bb plugin reload provider-pi-durable`.

---

## Triaged Findings (S5 Triage Gate)

| ID | Component | Severity | Rule | Decision | Description & Root Cause |
|---|---|---|---|---|---|
| **F-89-1** | `src/runner/subagent.ts` | **P1** | AP-010, AP-034 | `fix-now` | Subagent execution synchronously blocks the parent turn via `await submission.wait(context)`. Replace with non-blocking `background: true` execution by default. |
| **F-89-2** | `src/runner/subagent.ts` | **P1** | AP-012, AP-026 | `fix-now` | Child conversation lacks a Role Envelope, causing LLMs to assume root orchestrator identity and trigger exploratory loops. Inject strict role constraints into `instructions`. |
| **F-89-3** | `src/runner/subagent.ts` | **P1** | AP-010, AP-012 | `fix-now` | Unconditional removal of `Subagent` (`extensions: { remove: [Subagent] }`) prevents level 2+ nesting. Remove this blanket restriction. |
| **F-89-4** | `src/host/tool-delta-translator.ts` | **P2** | AP-020, AP-026 | `fix-now` | Visual delegation card does not reflect `background: true` execution status in timeline deltas. |

---

## Task Breakdown

### Slice 1: Subagent Tool Contract, Role Envelope & Non-Blocking Execution (F-89-1, F-89-2, F-89-3)
- **Boundary**: Domain / Runner (`src/runner/subagent.ts`)
- **AP Gates**: AP-010, AP-012, AP-019 (<200 lines), AP-026, AP-029
- [ ] Create failing test in `tests/subagent-async-envelope.test.ts`:
  - Test 1: Calling `subagent` with `background: true` (or omitted) creates child conversation with Role Envelope in `instructions`, does NOT remove `Subagent`, emits `details` with `background: true`, and returns immediately with `{ status: "spawned" }` without waiting for completion.
  - Test 2: Calling `subagent` with `background: false` preserves foreground execution and waits for `settled.answer`.
  - Test 3: Child conversations retain the `Subagent` tool so nesting level 2+ is permitted.
- [ ] Implement changes in `src/runner/subagent.ts`:
  - Add optional `background` parameter (TypeBox boolean, default `true`).
  - Inject structured `instructions` (Role Envelope) via `configure(tx, created.id, { instructions })`.
  - Remove `{ extensions: { remove: [Subagent] } }`.
  - When `background: true`, return immediately with `{ content: [{ type: "text", text: `Subagent spawned in background (conversation ${child})...` }], details: { conversationId: child, background: true, task: args.task } }`.
  - Keep file strictly < 200 lines (AP-019).
- [ ] Run `node --test tests/subagent-async-envelope.test.ts` (Green).

### Slice 2: Visual Delegation Card Background Status (F-89-4)
- **Boundary**: Presentation / Wire Adapters (`src/runner/bridge/tool-result-extractor.ts`, `src/host/tool-delta-translator.ts`)
- **AP Gates**: AP-012, AP-019 (<200 runner, <250 host), AP-026
- [ ] Create failing test in `tests/subagent-background-delegation.test.ts`:
  - Test 1: `buildToolItemShape` sets `background: true` on delegation shape when `event.details.background === true` or `args.background !== false`.
  - Test 2: `translateToolStart` and `translateToolEnd` include `background: true` in the delegation item.
- [ ] Update `src/host/tool-delta-translator.ts`:
  - Check `e.background` in `buildToolItemShape` for delegation tools.
  - Keep file strictly < 250 lines (AP-019).
- [ ] Run `node --test tests/subagent-background-delegation.test.ts` (Green).

### Slice 3: Host-Side Subthread Orchestration & Thread Registration
- **Boundary**: Host Bridge (`src/host/session.ts`, `src/host/subthread-spawner.ts`)
- **AP Gates**: AP-010, AP-019 (<250 lines), AP-020, AP-034
- [ ] Create failing test in `tests/host-subthread-background-spawner.test.ts`:
  - Verifies that Host Bridge handles `tool_execution_update` for background subagents, triggers `spawnSubthreadInBb`, and links `session.registerThread`.
- [ ] Verify `src/host/session.ts` and `src/host/subthread-spawner.ts` maintain line limits (<250 lines).
- [ ] Run `node --test tests/host-subthread-background-spawner.test.ts` (Green).

### Slice 4: Verification, Doctor, Ledger & Memory Update (S9–S12)
- **AP Gates**: AP-019, AP-022, AP-029
- [ ] Run `npx tsc --noEmit` (0 errors).
- [ ] Run full test suite: `npm test` (All tests green).
- [ ] Build runner and plugin: `npm run build`.
- [ ] Run `npm run doctor` to verify environment and extensions.
- [ ] Sync dist to BB plugin cache (`~/.bb/plugins/cache/.../dist/`) and reload plugin (`bb plugin reload provider-pi-durable`).
- [ ] Update `docs/arch-improvement/ledger.md` (Cycle 89).
- [ ] Update `docs/arch-improvement/memory.md` (Cycle 89 lessons).
- [ ] Provide terminal summary with ledger link.
