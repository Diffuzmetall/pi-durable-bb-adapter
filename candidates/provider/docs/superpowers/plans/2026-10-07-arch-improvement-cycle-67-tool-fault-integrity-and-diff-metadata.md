# Implementation Plan: Arch Improvement Cycle 67 (Tool Fault Integrity, Output Diagnostics & Diff Metadata)

**Cycle:** 67  
**Target Release:** `v0.2.12`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences:** D-5 (Tool fault masking), D-6 (Diff metadata preservation), D-9 (Output diagnostics & trimStart)  

---

## 1. Problem Statement & Primary Source Evidence

### 1.1 D-5: Tool Fault Masking on Absent Entry Record
In `@earendil-works/pi-durable` (`docs/spec.md:4129`):
```markdown
/** entry is absent when the tool task faulted or was orphaned. */
| { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
```
When a tool task in Pi Durable faults before intent, encounters unhandled exceptions, or is orphaned, `event.entry` is `undefined`.
In `src/runner/bridge/bb-event-adapter.ts`:
`const { result, isError } = extractToolResult(event.entry?.model?.[0]);`
`extractToolResult(undefined)` returns `{ result: "", isError: false }`.
**Violation:** An aborted or crashed tool execution is reported to BB as a successful completion with empty result! This directly violates **AP-012 (Fail-Fast & Explicit Contracts)** and **AP-013 (Data Integrity without Fakes)**.

### 1.2 D-6: Discarded Diff & Patch Metadata
In `@earendil-works/pi-coding-agent` (`src/core/tools/edit.ts:210`), tool executions return:
```typescript
details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine }
```
`BBEventAdapter` and `contracts.ts` currently drop `details` from wire events, preventing BB IDE from enriching `fileChange` items with granular patch and diff information.

### 1.3 D-9: Truncation Diagnostics & TrimStart
In `@earendil-works/pi-durable`, `tool_execution_update` emits:
`output?: { trimStart?: number; append?: string } | { set: string };`
and `diagnostics?: readonly ToolDiagnostic[];`
Currently `BBEventAdapter` only reads `output.set` and `output.append`, silently dropping `trimStart` and structured diagnostics.

---

## 2. Step-by-Step Implementation Slices

### Slice 1: Protocol Contracts Update (`src/runner/bridge/contracts.ts`)
- In `contracts.ts`:
  - Extend `tool_execution_end` wire event:
    ```typescript
    | {
        type: "tool_execution_end";
        toolCallId: string | number;
        toolName: string;
        result: string;
        isError: boolean;
        details?: unknown;
      }
    ```
  - Extend `tool_execution_update` wire event:
    ```typescript
    | {
        type: "tool_execution_update";
        toolCallId: string | number;
        toolName: string;
        partialResult: string;
        trimStart?: number;
      }
    ```

### Slice 2: Tool Fault Detection & Metadata Forwarding (`src/runner/bridge/bb-event-adapter.ts`)
- In `bb-event-adapter.ts`:
  - In `tool_execution_update`:
    - Extract `trimStart` from `event.output`:
      ```typescript
      let trimStart: number | undefined;
      if (event.output && "trimStart" in event.output) {
        trimStart = event.output.trimStart;
      }
      ```
    - Pass `trimStart` to `output({ type: "tool_execution_update", ... })`.
  - In `tool_execution_end`:
    - Check if `event.entry === undefined`:
      ```typescript
      if (event.entry === undefined) {
        this.output({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: "Tool execution faulted or was orphaned without generating an entry record.",
          isError: true,
        });
        break;
      }
      ```
    - If `entry` exists, extract `result`, `isError`, and `details` from `event.entry` or `event.entry.data`:
      ```typescript
      const { result, isError } = extractToolResult(event.entry?.model?.[0]);
      const details = (event.entry as { data?: unknown })?.data ?? (event as { details?: unknown })?.details;
      this.output({
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result,
        isError,
        details,
      });
      ```

### Slice 3: Host Tool Delta Translator Enrichment (`src/host/tool-delta-translator.ts`)
- In `src/host/tool-delta-translator.ts`:
  - In `translateToolEnd`:
    - If `event.isError` is true and `shape.item.type === "fileChange"`:
      Ensure status is `"failed"` and error message is populated from `event.result`.
    - If `event.details` contains `diff` or `patch`, attach to `shape.item` when appropriate while maintaining Zod conformance with `threadDeltaSchema`.

### Slice 4: Deterministic TDD Test Suite (AP-013, AP-028)
- Create or update `tests/tool-fault-and-diff.test.ts`:
  1. Test absent `event.entry` in `tool_execution_end` produces `isError: true` with descriptive fault result.
  2. Test valid `event.entry` with `isError: false` produces clean result.
  3. Test `event.entry` with explicit error preserves `isError: true`.
  4. Test `tool_execution_update` forwards `trimStart` when present.
  5. Test `tool-delta-translator` maps faulted tool end to failed item status.

### Slice 5: Verification, Release & Version Bump
1. Run `npm test` and verify 100% passing tests (63 + new tests).
2. Verify AP-019 line limits (< 250 lines per file).
3. Verify AP-029 (zero `as any`).
4. Bump version to `0.2.12` in `package.json`.
5. Update `docs/arch-improvement/ledger.md` with Cycle 67 entry.
6. Commit & tag `v0.2.12`.
7. Reload plugin in BB IDE (`bb plugin reload provider-pi-durable`).
