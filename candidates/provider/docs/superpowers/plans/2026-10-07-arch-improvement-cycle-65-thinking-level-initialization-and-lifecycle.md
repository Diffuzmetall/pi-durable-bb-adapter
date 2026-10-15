# Arch Improvement Plan: Cycle 65 — Durable Thinking Level Initialization & Reasoning Lifecycle Parity

**Target:** `bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Prior Cycle:** Cycle 64 (`v0.2.9`, commit `6e5682e`)  
**Target Version:** `v0.2.10`

---

## 1. Findings from Cycle 64 Forensic Investigation

| Finding | Target File | Severity | Rule | Resolution Plan |
|---|---|---|---|---|
| **F-65-1** | `src/runner/runtime-loader.ts` | **P1** | **AP-010, AP-018:** `LoadedHarnessEnvironment` interface discards `initial.thinkingLevel`. | Add `initialThinkingLevel?: ModelThinkingLevel` to `LoadedHarnessEnvironment` and return `initialThinkingLevel: initial?.thinkingLevel` in `loadHarnessEnvironment`. |
| **F-65-2** | `src/runner/runtime.ts` | **P1** | **AP-010, AP-026:** `harness.root()` does not pass `thinkingLevel` into `agent: { ... }`, and `if (!location.created)` skips configuration for all new sessions. | 1. Pass `...(envState.initialThinkingLevel ? { thinkingLevel: envState.initialThinkingLevel } : {})` into `harness.root(runtimeContext, { agent: { ... } })`.<br>2. When resuming (`!location.created`), also apply `cli.thinkingLevel` via `root.configure`. |
| **F-65-3** | `src/runner/bridge/bb-event-adapter.ts` | **P1** | **AP-018, AP-026:** `BBEventAdapter` never emits `thinking_end` when transitioning to `text_delta`, `tool_execution_start`, `message_end`, or `turn_end`. | Track `isInThinking: boolean`. When transitioning from thinking to text, tool calls, or message/turn end, emit `assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking }` and reset `isInThinking = false`. |

---

## 2. Implementation Slices

### Slice 1: Runner Initialization Plumbing (`runtime-loader.ts` & `runtime.ts`)
- In `src/runner/runtime-loader.ts`:
  - In `LoadedHarnessEnvironment`, add `initialThinkingLevel?: ModelThinkingLevel;`.
  - In `loadHarnessEnvironment`, set `initialThinkingLevel: initial?.thinkingLevel`.
- In `src/runner/runtime.ts`:
  - When calling `harness.root(...)`:
    ```typescript
    const root = await harness.root(runtimeContext, {
      agent: {
        cwd: location.cwd,
        ...(envState.initialModelRef ? { model: envState.initialModelRef } : {}),
        ...(envState.initialThinkingLevel ? { thinkingLevel: envState.initialThinkingLevel } : {}),
      },
    });
    ```
  - For resumed sessions (`!location.created`), ensure `root.configure({ model: cli.model, thinkingLevel: cli.thinkingLevel })` is called when `options.cli` is provided.

### Slice 2: Reasoning Lifecycle Stream Closure (`bb-event-adapter.ts`)
- In `src/runner/bridge/bb-event-adapter.ts`:
  - Add private `isInThinking = false;`.
  - In `handleEvent`:
    - Helper method `closeThinkingIfNeeded()`:
      ```typescript
      private closeThinkingIfNeeded(): void {
        if (!this.isInThinking) return;
        this.isInThinking = false;
        this.output({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: this.currentThinking,
          },
        });
      }
      ```
    - When `change.type === "thinking_delta"`: set `this.isInThinking = true;`.
    - When `change.type === "text_delta"`: call `this.closeThinkingIfNeeded()` before emitting `text_delta`.
    - On `tool_execution_start`, `message_end`, `turn_end`, and `run_end`: call `this.closeThinkingIfNeeded()`.

### Slice 3: Host Message Delta Translator Fallback Closure
- In `src/host/message-delta-translator.ts`:
  - Ensure that if `text_delta` or `message_end` arrives while channels remain in `state.openThinkingChannels`, any unclosed thinking channels emit `item.textClose` on `channel: "reasoningText"`.

### Slice 4: Non-Trivial Test Suite (AP-013, AP-028)
- Update/add tests in `tests/thinking-presentation.test.ts` and `tests/bb-event-adapter.test.ts`:
  - Test `BBEventAdapter` emits `thinking_end` when `text_delta` follows `thinking_delta`.
  - Test `BBEventAdapter` emits `thinking_end` on `message_end` if no `text_delta` occurred.
  - Test `runtime-loader.ts` preserves `initialThinkingLevel`.
  - Test all 59+ unit tests pass.

### Slice 5: Verification, Version Bump & Release
- Rebuild: `node scripts/build-runner.mjs && bb plugin build`.
- Line count check: all files < 250 lines (AP-019).
- Bump version to `0.2.10` in `package.json`.
- Update `docs/arch-improvement/ledger.md` with Cycle 65 entry.
- Commit and tag: `git commit -m "feat(arch): durable thinking level init and lifecycle parity (cycle 65, v0.2.10)" && git tag v0.2.10`.
- Reload plugin: `bb plugin reload provider-pi-durable`.
