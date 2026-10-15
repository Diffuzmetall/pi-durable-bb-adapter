# Implementation Plan: Arch Improvement Cycle 68 (Checkpoint Extraction, Native Event Stream & `turn.boundary` Parity)

**Cycle:** 68  
**Target Release:** `v0.2.13`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences:** D-11 (Checkpoints in `turn.boundary`), D-10 (`snapshot` event on reconnect), D-3 (`auto_retry` events)  

---

## 1. Problem Statement & Primary Source Evidence

### 1.1 D-11: Missing `providerCheckpointId` in `turn.boundary`
In BB IDE core (`start-server.js:184010-184017`):
```javascript
const precedingProviderCheckpoint = precedingTurnId === null ? null : resolveTurnProviderCheckpointId({
  providerCheckpointId: precedingCompletion?.providerCheckpointId,
  providerId: thread.providerId,
  turnId: precedingTurnId
});
if (precedingTurnId !== null && precedingProviderCheckpoint === null) {
  conflict("This earlier provider turn has no editable history checkpoint");
}
```
When a user clicks "Edit" on a message or runs `bb thread edit-message`, BB requires `precedingCompletion.providerCheckpointId`. Without it, BB throws HTTP 409 conflict.
In `@earendil-works/pi-durable`:
Every committed transaction appends entries to `current.conversation.entries`. The tail entry `id` (`EntryId`) represents the exact point-in-time checkpoint for `conversation.fork(checkpointEntryId)`!
Currently, `message-delta-translator.ts` emits `turn.boundary` without `providerCheckpointId`.

### 1.2 D-10: Dropped `snapshot` Event on Stream Connect
In `@earendil-works/pi-durable` (`spec.md:4223`), when `watchEvents` connects or recovers after high event backlog, it delivers a `snapshot` of the newest committed state (`view: ConversationView`).
Currently, `BBEventAdapter` ignores `snapshot`, losing the prime entry ID for session checkpoint tracking.

### 1.3 D-3: Dropped `auto_retry_start` and `auto_retry_end`
When a provider encounters transient errors (e.g. 429 rate limit or network glitch), Durable emits `auto_retry_start` and `auto_retry_end`. Currently dropped by `BBEventAdapter`.

---

## 2. Step-by-Step Implementation Slices

### Slice 1: Protocol Contracts Update (`contracts.ts` & `types.ts`)
- In `src/runner/bridge/contracts.ts`:
  - Extend `BBTurnEndEvent` and `BBAgentEndEvent` with `providerCheckpointId?: string;`.
  - Add `BBAutoRetryStartEvent`:
    ```typescript
    | {
        type: "auto_retry_start";
        attempt: number;
        at?: number;
        errorMessage?: string;
      }
    ```
  - Add `BBAutoRetryEndEvent`:
    ```typescript
    | {
        type: "auto_retry_end";
        attempt: number;
        success?: boolean;
      }
    ```
- In `src/host/types.ts`:
  - Extend `RunnerEvent` with `providerCheckpointId?: string;`.

### Slice 2: Checkpoint Tracking & Native Event Translation (`bb-event-adapter.ts`)
- In `src/runner/bridge/bb-event-adapter.ts`:
  - Add private field `lastCheckpointId?: string;`.
  - In `handleEvent`:
    - Handle `case "snapshot"`:
      ```typescript
      case "snapshot": {
        const tail = event.view?.conversation?.entries?.at(-1);
        if (tail?.id !== undefined) {
          this.lastCheckpointId = String(tail.id);
        }
        break;
      }
      ```
    - In `case "turn_end"` and `case "run_end"`:
      Inspect `current?.conversation?.entries?.at(-1)`:
      ```typescript
      const tail = current?.conversation?.entries?.at(-1);
      if (tail?.id !== undefined) {
        this.lastCheckpointId = String(tail.id);
      }
      ```
      Pass `providerCheckpointId: this.lastCheckpointId` to `this.output({ type: "turn_end", ..., providerCheckpointId })` and `run_end`.
    - Handle `case "auto_retry_start"`:
      Emit `{ type: "auto_retry_start", attempt: event.attempt, at: event.at, errorMessage: event.errorMessage }`.
    - Handle `case "auto_retry_end"`:
      Emit `{ type: "auto_retry_end", attempt: event.attempt }`.

### Slice 3: Host `turn.boundary` Delta Attachment (`message-delta-translator.ts`)
- In `src/host/message-delta-translator.ts`:
  - In `translateAgentEnd`:
    Attach `providerCheckpointId` to `turn.boundary`:
    ```typescript
    deltas.push({
      kind: "turn.boundary",
      status: "completed",
      claimIfIdle: true,
      ...(event.providerCheckpointId ? { providerCheckpointId: event.providerCheckpointId } : {}),
    });
    ```

### Slice 4: Non-Trivial Test Suite (AP-013, AP-028)
- Create `tests/checkpoints-and-snapshot.test.ts`:
  1. Test `turn_end` and `agent_end` emit `providerCheckpointId` matching tail entry ID.
  2. Test `snapshot` event initializes `lastCheckpointId`.
  3. Test `auto_retry_start` and `auto_retry_end` wire emissions.
  4. Test `translateAgentEnd` attaches `providerCheckpointId` to `turn.boundary`.
  5. Validate `turn.boundary` delta with `threadDeltaSchema.safeParse` from `@get-bb/plugin-sdk/provider-bridge`.
- Verify all 70 existing tests + new tests pass.

### Slice 5: Verification, Release & Version Bump
1. Run `npm test` and verify 100% passing tests.
2. Verify AP-019 file line limits (< 250 lines).
3. Verify AP-029 strict TypeScript (zero `as any`).
4. Bump `package.json` to `"version": "0.2.13"`.
5. Update `docs/arch-improvement/ledger.md` with Cycle 68 entry.
6. Commit & tag `v0.2.13`.
7. Reload plugin: `bb plugin reload provider-pi-durable`.
