# Implementation Plan: Arch Improvement Cycle 70 (Cumulative Token Usage Monotonicity & pi.usage Sync, D-7)

**Cycle:** 70  
**Target Release:** `v0.2.16`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences:** D-7 (Cumulative Token Usage Reset / Falsification)  

---

## 1. Problem Statement & Primary Sources

### 1.1 The Falsified Total Spend Bug (D-7)
In Beyond Boundaries IDE, the thread header and telemetry display two sets of metrics:
- `last`: The token spend of the current/last turn.
- `total`: The cumulative token spend across all turns in the thread.

Currently in `src/host/message-delta-translator.ts` (lines 186–203):
```typescript
return [
    {
        kind: "usage",
        modelContextWindow: cwSize,
        last: {
            totalTokens: totTok,
            inputTokens: inTok,
            ...
        },
        total: {
            totalTokens: totTok,
            inputTokens: inTok,
            ...
        },
    },
    ...
];
```
`total` is hardcoded to be an identical copy of `last`!
On Turn 1: 500 tokens -> `total: 500`.
On Turn 2: 600 tokens -> `total: 600` (the 500 tokens from Turn 1 vanish!).
The session total spend resets on every turn, violating AP-013 (Data Integrity).

### 1.2 Primary Source Parity (`@earendil-works/pi-durable` `pi.usage` Document)
In `@earendil-works/pi-durable` (`usage.ts:10-25` and `generation.ts:650-655`):
1. Every assistant entry and tool execution atomically commits its spend to the `pi.usage` document:
   ```typescript
   export type UsageState = {
       models: Record<string, Usage>;
       tools: Record<string, Usage>;
   };
   ```
2. The `pi.usage` document lives inside `current.conversation.docs["pi.usage"]` and is strictly monotonic:
   `totals only grow`.
3. In `contracts.ts`, `BBAssistantMessage` or `BBTurnEndEvent` / `BBAgentEndEvent` should carry `cumulativeUsage`:
   ```typescript
   export interface CumulativeUsageMetrics {
       totalTokens: number;
       inputTokens: number;
       outputTokens: number;
       cachedInputTokens?: number;
       cacheWriteInputTokens?: number;
   }
   ```
4. `translateAgentEndUsage` should populate `delta.total` with the cumulative values from `cumulativeUsage` (falling back to accumulating if absent), while keeping `delta.last` as the turn-specific spend.

---

## 2. Step-by-Step Implementation Slices

### Slice 1: Protocol Contract Extension (`src/runner/bridge/contracts.ts` & `src/host/types.ts`)
- In `src/runner/bridge/contracts.ts`:
  - Define `CumulativeUsageMetrics`:
    ```typescript
    export interface CumulativeUsageMetrics {
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        cacheWriteInputTokens?: number;
    }
    ```
  - In `BBTurnEndEvent` and `BBAgentEndEvent`, add optional `cumulativeUsage?: CumulativeUsageMetrics;`.
- In `src/host/types.ts`:
  - In `RunnerEvent`, add optional `cumulativeUsage?: CumulativeUsageMetrics;`.

### Slice 2: Cumulative Usage Aggregation in Runner Bridge (`src/runner/bridge/bb-event-adapter.ts` & `assistant-message-builder.ts`)
- In `src/runner/bridge/assistant-message-builder.ts`:
  - Implement helper `extractCumulativeUsage(current: DurableView): CumulativeUsageMetrics | undefined`:
    - Reads `current.conversation.docs["pi.usage"]`.
    - Iterates over `usageDoc.models` and `usageDoc.tools`.
    - Sums `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens`.
- In `src/runner/bridge/bb-event-adapter.ts`:
  - On `turn_end` and `run_end`, compute `const cumulativeUsage = extractCumulativeUsage(current);`.
  - Pass `cumulativeUsage` to `this.output({ type: "turn_end", ..., cumulativeUsage })` and `run_end`.

### Slice 3: Monotonic Total Delta Emission (`src/host/message-delta-translator.ts`)
- In `src/host/message-delta-translator.ts`:
  - Update `translateAgentEnd(event, currentAgentText, turnBoundarySent)`:
    Pass `event.cumulativeUsage` into `translateAgentEndUsage(rawMsg, event.contextWindow, event.cumulativeUsage)`.
  - In `translateAgentEndUsage`:
    - `last` uses the turn's `usage`.
    - `total` uses `cumulativeUsage` if provided:
      ```typescript
      total: {
          totalTokens: cumulativeUsage?.totalTokens ?? totTok,
          inputTokens: cumulativeUsage?.inputTokens ?? inTok,
          cachedInputTokens: cumulativeUsage?.cachedInputTokens ?? Number(usage.cacheRead ?? 0),
          cacheReadInputTokens: cumulativeUsage?.cachedInputTokens ?? Number(usage.cacheRead ?? 0),
          cacheWriteInputTokens: cumulativeUsage?.cacheWriteInputTokens ?? Number(usage.cacheWrite ?? 0),
          outputTokens: cumulativeUsage?.outputTokens ?? outTok,
          reasoningOutputTokens: Number(usage.reasoning ?? 0),
      }
      ```
    - Ensures that `total` is strictly monotonic and never drops below previous totals.

### Slice 4: Deterministic Unit & Contract Tests (`tests/cumulative-usage.test.ts`)
- Create `tests/cumulative-usage.test.ts` (< 200 lines, AP-028):
  1. `extractCumulativeUsage` correctly sums across multiple models and tools in `pi.usage`.
  2. `BBEventAdapter` outputs `cumulativeUsage` on `turn_end` and `run_end` from `current.conversation.docs["pi.usage"]`.
  3. `translateAgentEndUsage` sets `last` to current turn and `total` to cumulative values.
  4. Validates the resulting `usage` delta with `threadDeltaSchema.safeParse` from `@get-bb/plugin-sdk/provider-bridge`.
  5. Multi-turn monotonicity test: verify that across Turn 1 and Turn 2, `delta.total.totalTokens` strictly grows.

### Slice 5: Verification, Version Bump & Tag
1. Run `npm test` and verify all 85+ tests pass with zero failures.
2. Verify AP-019 line limits (< 250 lines).
3. Verify AP-029 strict TypeScript (zero `as any`).
4. Bump `package.json` to `"version": "0.2.16"`.
5. Update `docs/arch-improvement/ledger.md` with Cycle 70.
6. Commit & tag `v0.2.16`.
7. Reload plugin: `bb plugin reload provider-pi-durable`.
