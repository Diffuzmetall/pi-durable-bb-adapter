# Arch Improvement Plan: Cycle 57 — Context Window Telemetry & Usage Synchronization

**Date:** 2026-10-07  
**Goal:** Fix context window usage estimation (`usedTokens`), token telemetry synchronization, and model context window propagation in `bb-plugin-provider-pi-durable` so that BB IDE's ring indicator and context fullness bar display accurate live values.  
**Standard:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-loop` & `systematic-debugging`

---

## 1. Problem Statement & Root Cause Analysis

### Reproduction & Symptoms
- In BB thread `thr_7g8t2mvnte`, `bb thread context thr_7g8t2mvnte` reported:
  ```json
  {"usage": {"estimated": true, "modelContextWindow": 1048576, "usedTokens": 0}}
  ```
  The context fullness indicator in BB was permanently stuck at 0 tokens, despite multiple turns with ~45k actual tokens consumed and committed to the ACID SQLite store.
- `thread/contextWindowUsage/updated` was only emitted once early in the thread (seq 238) with `usedTokens: 0`, and was never emitted again across turns 3, 4, 5, 6.
- `thread/tokenUsage/updated` reported `modelContextWindow: 128000` instead of the active model's window (`1048576` for `antigravity/gemini-3.8-flash`).

### Root Causes
1. **Runner RPC Response Unwrapping (`src/host/runner-process.ts`):**  
   The runner emits responses as `{ id, type: "response", command, success: true, data: { ... } }`. `RunnerProcess.requestOk` resolved with the full raw message rather than `msg.data ?? msg.result ?? msg`, and did not check `success === false`.
2. **Context Stats Extraction Failure (`src/host/session.ts`):**  
   `getSessionStats()` evaluated `res?.contextUsage`. Because `contextUsage` was nested inside `res.data.contextUsage`, `res.contextUsage` evaluated to `undefined`, defaulting to `{ tokens: null, contextWindow: 0 }`.
3. **Dropped Context Window Deltas (`src/host/session.ts`):**  
   `refreshContextUsage()` required `stats.contextWindow > 0`. Because `contextWindow` was `0`, the condition failed (`0 > 0 === false`), silently suppressing all `contextWindow` delta notifications on every turn.
4. **Turn Boundary Ordering Hazard (`src/host/session.ts`):**  
   `handleRunnerEvent` emitted `agent_end` deltas (including `turn.boundary: completed`) *before* awaiting `refreshContextUsage()`. This meant `contextWindow` updates were delivered asynchronously after the turn had already closed.
5. **Model Context Window Resolution Fallback (`src/runner/session-commands.ts`):**  
   `get_session_stats` inspected `current.conversation.docs["pi.agent"]`. If the model was not yet persisted in the agent document (e.g. before first turn), it defaulted to 128,000 instead of falling back to `args.provider` and `args.model`.
6. **Context Window Propagation in Event Adapter (`src/runner/bridge/bb-event-adapter.ts`):**  
   `BBEventAdapter` did not propagate `contextWindow` on `turn_end` or `run_end` (`agent_end`), causing `DeltaTranslator` to fall back to `128000` for `usage` deltas.
7. **Legacy Session Directory Backward-Compatibility (`src/runner/sessions.ts`):**  
   If a session directory without `.jsonl` does not yet contain `session.sqlite`, check if `${directory}.jsonl/session.sqlite` exists to seamlessly adopt legacy sessions.

---

## 2. Architecture & Design Rules

- **AP-010 (Modular Monolith & Ports/Adapters):** Maintain strict boundary separation between host RPC communication, delta translation, and runner storage.
- **AP-012 (Fail-Fast & Explicit Error Contracts):** `requestOk` must reject on `success === false` with the error message returned by the runner.
- **AP-013 (Data Integrity without Fakes):** Context token counts must reflect genuine SQLite message estimates via `estimateContextTokens` from `@earendil-works/pi-ai`.
- **AP-019 (File Size Limits & Modularity):** All files remain strictly below 250 lines (soft limit 150 lines).
- **AP-022 (Typed Errors & Explicit Exception Handling):** Handle missing or polymorphic response payloads gracefully (`res?.contextUsage ?? res?.data?.contextUsage`).
- **AP-023 (Async Discipline):** Await `refreshContextUsage()` before closing turns on `agent_end`.
- **AP-028 (Testing Strategy & Determinism):** Pure unit and integration tests covering response unwrapping, stats calculation, event adapter propagation, and delta translation without network I/O.

---

## 3. Implementation Steps (TDD)

### Phase 1: Test Suite
- Create `tests/context-window-usage.test.ts`:
  1. `RunnerProcess.requestOk` unwraps `data` property and rejects on `success: false`.
  2. `PiThreadSession.getSessionStats()` extracts `contextUsage` from both wrapped `{ data: { contextUsage } }` and raw `{ contextUsage }` envelopes.
  3. `PiThreadSession.refreshContextUsage()` sends `kind: "contextWindow"` delta with accurate `used` and `size`.
  4. `handleRunnerEvent("agent_end")` refreshes context usage before finalizing the turn.
  5. `BBEventAdapter` outputs `contextWindow` on `run_end` / `turn_end` when resolver is provided.
  6. `DeltaTranslator` uses `event.contextWindow` when computing `usage` deltas.

### Phase 2: Host Fixes
- Edit `src/host/runner-process.ts`:
  - Update `handleIncoming`: resolve with `msg.data !== undefined ? msg.data : (msg.result ?? msg)`.
  - Update `requestOk`: throw if `res.success === false`; return `res.data !== undefined ? res.data : (res.result ?? res)`.
- Edit `src/host/session.ts`:
  - Update `getSessionStats()`: extract `const usage = res?.contextUsage ?? res?.data?.contextUsage ?? res;`
  - Update `handleRunnerEvent`: on `agent_end`, await `refreshContextUsage()` before translating and dispatching `agent_end` deltas.

### Phase 3: Runner Fixes
- Edit `src/runner/session-commands.ts`:
  - In `get_session_stats`: check `args.provider` and `args.model` as fallback for `agentDoc.model`.
- Edit `src/runner/bridge/bb-event-adapter.ts`:
  - Add optional `resolveContextWindow` callback to constructor.
  - Include `contextWindow` in `turn_end` and `agent_end` outputs.
- Edit `src/runner/index.ts`:
  - Provide `(provider, modelId) => ...` resolver to `BBEventAdapter`.
- Edit `src/runner/sessions.ts`:
  - Add legacy directory fallback for `${directory}.jsonl`.

### Phase 4: Translator Fixes
- Edit `src/host/delta-translator.ts`:
  - Use `typeof event.contextWindow === "number" && event.contextWindow > 0 ? event.contextWindow : 128000` in `agent_end` `usage` delta.

### Phase 5: Verification & Build
- Run `npm test` and verify 100% pass rate.
- Run `npm run build` (`scripts/build-runner.mjs` and `bb plugin build`).
- Verify line counts (AP-019).
- Update ledger in `docs/arch-improvement/ledger.md`.
- Create GitHub issue in `VanDalkvist/bb-plugin-provider-pi-durable`.
