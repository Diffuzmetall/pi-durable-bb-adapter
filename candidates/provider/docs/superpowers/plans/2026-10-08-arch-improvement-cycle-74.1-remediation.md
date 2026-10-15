# Architecture Improvement Cycle 74.1 Plan: Remediation of Cycle 74 Audit Findings

**Cycle:** 74.1 (Remediation Slice: UI Notice Forwarding, Scoping, Guaranteed Tool Result, Dynamic Prompt Integrity & Strict TypeScript)  
**Date:** 2026-10-08  
**Repo:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**Audit Reference:** Independent Audit from `thr_reatqq4wr6` on commit `3f504f8`  

---

## 1. Goal & Architecture Context Map

Remediate all findings flagged by the Independent Auditor in `thr_reatqq4wr6` for Cycle 74 (`3f504f8`):
- [P1-1] UI Notice Forwarding (D-19): Unpack startup notice records and wire live forwarder for mid-session notices.
- [P1-2] Scoping Bug in `openDurable`: Hoist `envState` above `try` block to prevent `ReferenceError` during error cleanup.
- [P2-1] Guaranteed `tool_result` Emission: Ensure tool exceptions emit `tool_result` with `isError: true` in `adaptExtensionTool` and `createNestedToolExecutor`.
- [P2-2] Truthy Check for Dynamic Prompt Sections: Filter out empty, null, or whitespace-only sections in `buildSections`.
- [P2-3] TypeScript Type Consistency in `session-commands.ts`: Add `instructions?`, guard `cmd.level`, handle fallback command type.
- [P3] Clean Dynamic Prompt Section Replacement: Replace `this.sections = { ...sections }` instead of `Object.assign`.
- Zero TypeScript Errors: Ensure `npx tsc --noEmit` exits with status code 0 across all files in `src/`.

### Architecture Map
```
Host Layer:
  - src/host/bridge.ts                 <-- Strict parameter type narrowing
  - src/host/delta-translator.ts       <-- Public fields for MessageTranslationState compliance

Runner Layer:
  - src/runner/runtime-loader.ts       <-- Live notice forwarder hook, ResourceLoaderLike compatibility
  - src/runner/runtime.ts              <-- envState hoisting, notice record unpacking, live forwarder registration
  - src/runner/extension-bridge.ts     <-- try/catch in adaptExtensionTool with guaranteed tool_result, strict types
  - src/runner/extension-mount.ts      <-- try/catch in createNestedToolExecutor with guaranteed tool_result, valid shutdown reason
  - src/runner/prompt.ts               <-- dynamic section replacement, truthy/whitespace filtering, tool def cwd args
  - src/runner/session-commands.ts     <-- RunnerCommandPayload.instructions, thinking level guard, unknown type fallback
  - src/runner/bridge/contracts.ts     <-- ConversationEntryRecord.id type widening (unknown)
  - src/runner/bridge/bb-event-adapter.ts <-- Import type ConversationEntryRecord
```

---

## 2. Triaged Findings (`fix-now`)

| ID | Severity | Rule | File(s) | Description & Resolution |
|---|---|---|---|---|
| **F-74.1-1** | **P1** | AP-010, AP-024 | `src/runner/runtime.ts`, `src/runner/runtime-loader.ts` | **UI Notice Forwarding (D-19):** Notice records were stringified into `"[object Object]"`. Post-startup notices were dropped. Resolve by unpacking `{ kind: "notice", level, message }` and adding `setNoticeForwarder` hook. |
| **F-74.1-2** | **P1** | AP-012, AP-022 | `src/runner/runtime.ts` | **Scoping Bug in `openDurable`:** `envState` scoped inside `try`, causing `ReferenceError` in `catch`. Hoist `let envState` above `try`. |
| **F-74.1-3** | **P2** | AP-012, AP-026 | `src/runner/extension-bridge.ts`, `src/runner/extension-mount.ts` | **Guaranteed `tool_result` Emission:** Tool execution errors did not emit `tool_result` event to extensions. Wrap execution in `try/catch` and emit `runner.emitToolResult({ isError: true, ... })`. |
| **F-74.1-4** | **P2** | AP-013, AP-026 | `src/runner/prompt.ts` | **Dynamic Prompt Truthy Filter:** Empty or whitespace dynamic sections produced empty XML tags. Filter out non-truthy and whitespace strings. |
| **F-74.1-5** | **P2** | AP-029 | `src/runner/session-commands.ts` | **TypeScript Type Consistency:** Missing `instructions?`, unguarded `cmd.level`, unguarded `cmd.type`. Add payload field, guards, and fallback. |
| **F-74.1-6** | **P3** | AP-011, AP-049 | `src/runner/prompt.ts` | **Dynamic Prompt Section Replacement:** `Object.assign` leaked removed sections across turns. Replace with `this.sections = { ...sections }`. |
| **F-74.1-7** | **P2** | AP-029 | Entire `src/` | **TypeScript Zero-Error Baseline:** Resolve all TypeScript compilation errors reported by `npx tsc --noEmit` without `as any`. |

---

## 3. Implementation Plan & Fix Slices

### Slice 1: Scoping & UI Notice Forwarding (P1-1, P1-2)
- [ ] **Step 1.1:** In `src/runner/runtime-loader.ts`:
  - Add `setNoticeForwarder?: (forwarder: (level: "info" | "warning" | "error", message: string) => void) => void;` to `LoadedHarnessEnvironment`.
  - In `loadHarnessEnvironment`: Wire `onNotice` callback to call `liveNoticeForwarder(level, message)` if registered, else push to `pendingReports`.
  - Fix `ResourceLoaderLike` skills return type compatibility (`Skill[] | { skills: Skill[] }`).
- [ ] **Step 1.2:** In `src/runner/runtime.ts`:
  - Hoist `let envState: LoadedHarnessEnvironment | undefined;` above `try { ... }`.
  - When draining `pendingReports`, check for `{ kind: "notice", level, message }` and invoke `notice(report.level, report.message)`.
  - Register `envState.setNoticeForwarder?.((level, message) => notice(level, message));`.
  - In `catch (error: unknown)`: safely access `envState?.cleanup?.()`.

### Slice 2: Guaranteed Tool Result Emission on Exception (P2-1)
- [ ] **Step 2.1:** In `src/runner/extension-bridge.ts`:
  - Wrap `await toolDef.execute(...)` in `try / catch`.
  - In `catch (err: unknown)`: emit `runner.emitToolResult({ type: "tool_result", toolName: toolDef.name, toolCallId: api.callId, input, content: [{ type: "text", text: message }], isError: true })`.
  - Return `{ content: [{ type: "text", text: message }], isError: true }`.
- [ ] **Step 2.2:** In `src/runner/extension-mount.ts`:
  - In `createNestedToolExecutor`'s `catch (err: unknown)` block: emit `await runner.emitToolResult(...)` with `isError: true` before returning error outcome.
  - Fix `session_shutdown` reason to `"quit"` (satisfying `SessionShutdownEvent` union).

### Slice 3: Dynamic Prompt Integrity & Section Replacement (P2-2, P3)
- [ ] **Step 3.1:** In `src/runner/prompt.ts`:
  - In `DynamicPromptSections.updateSections(sections)`: Replace `this.sections = { ...sections }`.
  - In `createPiPrompt.buildSections`: Filter `extra.mcp_servers` to check for non-empty string.
  - Filter `otherEntries` with `Boolean(text && typeof text === "string" && text.trim().length > 0)`.
  - Supply `process.cwd()` to `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`.
  - Support `{ skills: Skill[] }` object or array in `resolveSkills`.

### Slice 4: Command Payload & Full TypeScript Consistency (P2-3, AP-029)
- [ ] **Step 4.1:** In `src/runner/session-commands.ts`:
  - Add `instructions?: string` to `RunnerCommandPayload`.
  - In `case "set_thinking_level"`: guard `if (!cmd.level) { respond.error(cmd.id, "set_thinking_level", "Missing thinking level"); return; }`.
  - In `default:`: pass `cmd.type ?? "unknown"` to `respond.error`.
- [ ] **Step 4.2:** In `src/runner/extension-bridge.ts`:
  - Change `createCodemodeExtension({ mode: "auto" })` to `{ mode: "on" }`.
  - Safely cast `ctx` to `ExtensionToolContext` via `as unknown as ExtensionToolContext`.
  - Set `isError: result.isError ?? false`.
  - Pass `{ type: "session_start", reason: "startup" }`.
  - Cast actions to `ExtensionActions` via `as unknown as ExtensionActions`.
- [ ] **Step 4.3:** In `src/runner/bridge/contracts.ts` & `src/runner/bridge/bb-event-adapter.ts`:
  - Change `ConversationEntryRecord['id']` to `unknown`.
  - Import `type ConversationEntryRecord` in `bb-event-adapter.ts`.
- [ ] **Step 4.4:** In `src/host/bridge.ts` & `src/host/delta-translator.ts`:
  - Narrow `params.cwd` and `params.threadId`.
  - Make `currentThinkingIndex`, `currentAgentText`, `openThinkingChannels` public in `DeltaTranslator`.

### Slice 5: Regression Tests & Verification (AP-028)
- [ ] **Step 5.1:** Add regression tests in `tests/mcp-tool-hooks.test.ts` and `tests/mcp-prompt-sync.test.ts` or a new test file `tests/cycle-74-remediation.test.ts`:
  - Verify notice record unpacking without `"[object Object]"`.
  - Verify live mid-session notice forwarding.
  - Verify tool throwing exception emits `tool_result` with `isError: true`.
  - Verify dynamic prompt section deletion on subsequent turn update.
  - Verify whitespace/empty section suppression.
- [ ] **Step 5.2:** Run `npx tsc --noEmit` and confirm 0 errors.
- [ ] **Step 5.3:** Run `npm run build` and confirm 0 errors.
- [ ] **Step 5.4:** Run `npm test` and confirm 100% pass rate.
- [ ] **Step 5.5:** Check line counts (`wc -l`) for AP-019 (< 250 limit).
- [ ] **Step 5.6:** Update `docs/arch-improvement/ledger.md` with Cycle 74.1 section.
