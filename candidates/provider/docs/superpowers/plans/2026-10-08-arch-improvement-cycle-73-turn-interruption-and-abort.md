# Implementation Plan: Arch Improvement Cycle 73 (Clean Turn Interruption, Inbox Abort & Cancellation, `submission.abort`)

## Baseline & Context
- **Governing Standard:** `arch-rules.md` (AP-010 – AP-071)
- **Primary Sources:**
  - `@earendil-works/pi-durable` (`/Users/vanya/Projects/pi/packages/durable`): `conversation.abort()` withdraws pending inbox submissions with `{ status: "unanswered", reason: "aborted" }`, signals `invocation.controller.abort()`, sets assistant message `stopReason: "aborted"`, settles active tool calls with status `"aborted"`.
  - Native `provider-pi` (`/Users/vanya/Projects/bb-reference/server/dist/builtin-plugins/provider-pi/dist/host.js`): on `thread/stop` with `intent === "interrupt"` emits `{ kind: "session.ended" }` to close UI streams immediately, calls session abort, and returns `{ ok: true, providerCheckpointId: checkpointId ?? null }`.
- **Target Divergences & Deficiencies:**
  - `src/host/message-delta-translator.ts`: `translateAgentEnd` hardcodes `turn.boundary` status to `"completed"`, ignoring `stopReason === "aborted"`.
  - `src/host/bridge-router.ts`: `handleThreadStop` emitted ad-hoc `turn.boundary`, missed `session.ended` delta, and omitted `providerCheckpointId` in `{ ok: true }`, causing race conditions with `agent_end`.
  - `src/host/session.ts`: `lastCheckpointId` was not retained across events for retrieval on `thread/stop`.
  - `src/runner/bridge/bb-event-adapter.ts`: needs strict propagation of `stopReason: "aborted"` and `aborted: true` into `turn_end` and `agent_end` wire events.

---

## Slices Breakdown

### Slice 1: Runner Bridge Abort Event Propagation (`src/runner/bridge/contracts.ts`, `src/runner/bridge/bb-event-adapter.ts`)
- Add `aborted?: boolean; stopReason?: string;` to `BBTurnEndEvent` and `BBAgentEndEvent` contracts.
- In `BBEventAdapter`:
  - Deduplicate turn summary extraction between `turn_end` and `run_end` via private helper `resolveTurnSummary`.
  - Detect `isAborted` from `finalMsg.stopReason === "aborted"` or aborted assistant entries in current view.
  - Ensure `finalMsg.stopReason = "aborted"` and emit `{ aborted: true, stopReason: "aborted" }` on `turn_end` and `agent_end`.
- Keep `bb-event-adapter.ts` well under 220 lines (AP-019).

### Slice 2: Host Message Delta Translator Parity (`src/host/types.ts`, `src/host/message-delta-translator.ts`)
- Update `RunnerEvent` in `src/host/types.ts` to include `aborted?: boolean; stopReason?: string;`.
- In `translateAgentEnd`:
  - Detect `isInterrupted`: `event.aborted === true || event.stopReason === "aborted" || (rawMsg as { stopReason?: string })?.stopReason === "aborted"`.
  - Emit `turn.boundary` with `status: isInterrupted ? "interrupted" : "completed"`.
  - Strictly preserve `claimIfIdle: true` and `providerCheckpointId`.
- Verify conformance against `@get-bb/plugin-sdk/provider-bridge` `threadDeltaSchema`.

### Slice 3: Host Session Checkpoint Retention (`src/host/session.ts`)
- Add `private lastCheckpointId: string | null = null;` and `public getLastCheckpointId(): string | null`.
- In `handleRunnerEvent`: update `this.lastCheckpointId` whenever `event.providerCheckpointId` is present.
- File stays under 150 lines (AP-019).

### Slice 4: Bridge Router Clean Stop & Cancellation (`src/host/bridge-router.ts`, `src/host/bridge.ts`)
- Declare explicit TypeScript parameter types `ThreadStopParams`, `TurnStartParams`, `TurnSteerParams` (AP-029: 0 `any`).
- Update `handleThreadStop`:
  - When `intent === "interrupt"`:
    - Look up active session.
    - If active: emit notification `thread/delta` with `deltas: [{ kind: "session.ended" }]`.
    - Await `session.abort()`.
    - Return `sendResult(id, { ok: true, providerCheckpointId: session?.getLastCheckpointId() ?? null })`.
  - When `intent === "release"` (or default non-interrupt):
    - Await `ctx.registry.stop(params.threadId)`.
    - Return `sendResult(id, { ok: true })`.
- Remove legacy ad-hoc `turn.boundary` generation to eliminate turn closure races.

### Slice 5: Deterministic TDD Suite & Conformance Verification (`tests/interruption-and-cancellation.test.ts`)
- Test suite covering:
  1. `translateAgentEnd` translates aborted event into `turn.boundary` with `status: "interrupted"`.
  2. `translateAgentEnd` translates normal completion into `status: "completed"`.
  3. `threadDeltaSchema.safeParse` succeeds for `turn.boundary` (`interrupted`) and `session.ended`.
  4. `handleThreadStop` with `intent: "interrupt"` emits `session.ended`, triggers `session.abort()`, retains session in registry, and returns `providerCheckpointId`.
  5. `handleThreadStop` with `intent: "release"` stops registry session and returns `{ ok: true }`.
  6. `BBEventAdapter` correctly maps `stopReason: "aborted"` to `turn_end` and `agent_end` wire events with `aborted: true`.
  7. `PiThreadSession` tracks `lastCheckpointId` from incoming runner events.
- Update `tests/bridge-error-handling.test.ts` to reflect the corrected contract.

---

## Verification & Architecture Review
- Full test pass (`npm test`).
- TypeScript strict typecheck & build (`npm run build`).
- Line budget verification across all files (AP-019 < 250).
- Zero `as any` (AP-029).
- Update ledger and master plan.
- Bump version to `0.2.19` in `package.json`, commit and push to `main`.
