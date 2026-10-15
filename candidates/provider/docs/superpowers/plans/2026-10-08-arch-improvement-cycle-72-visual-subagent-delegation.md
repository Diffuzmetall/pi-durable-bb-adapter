# Implementation Plan: Arch Improvement Cycle 72 (Visual Subagent Delegation Cards, `type: "delegation"`)

**Cycle:** 72  
**Target Release:** `v0.2.18`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Epic:** Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)  

---

## 1. Problem Statement & Primary Sources

### 1.1 Subagent Tool Calls Invisible as Delegations
In Beyond Boundaries IDE, multi-agent workflows and subagent invocations are presented to the user via dedicated **Delegation Cards** in the chat timeline. The protocol defines `deltaDelegationShapeSchema`:
```typescript
interface DeltaDelegationShape {
    type: "delegation";
    childRef: string; // non-empty, excludes separator \u001f
    label: string;
    background: boolean;
    summary?: string;
}
```
Currently in `src/host/tool-delta-translator.ts`:
When the model calls the `subagent` tool (`toolName: "subagent"`), `buildToolItemShape` falls through to the generic fallback:
```typescript
return {
    type: "tool",
    tool: "subagent",
    server: "pi",
    args,
};
```
As a result, BB IDE renders the subagent call as an unspecialized raw MCP tool execution instead of an interactive, collapsible Subagent Delegation Card with bot icon, status badge, child summary, and expandable child execution logs.

### 1.2 Primary Source Parity (`@earendil-works/pi-durable` Subagent)
In `@earendil-works/pi-durable` (`test/examples/22-subagent-foreground.ts` and `src/runner/upstream/subagent-tool.ts`):
1. The `subagent` tool accepts `{ task: string }`.
2. The tool creates a child conversation owned by the task (`tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })`).
3. It emits `api.details({ conversationId: child })`.
4. When finished, it returns `{ content: [{ type: "text", text: answer }], details: { conversationId: child } }`.

---

## 2. Canonical Architecture & Proposed Solution

### Layer A: Tool Item Shape Translation (`src/host/tool-delta-translator.ts`)
1. In `buildToolItemShape(toolName, args, fallbackCwd)`:
   Add explicit branch for `subagent`:
   ```typescript
   if (toolName === "subagent") {
       const task = typeof args.task === "string" ? args.task.trim() : "";
       const label = task.length > 80 ? task.slice(0, 77) + "..." : task || "Subagent task";
       const childRef = typeof args.conversationId === "string" && args.conversationId.length > 0
           ? args.conversationId
           : typeof args.childRef === "string" && args.childRef.length > 0
               ? args.childRef
               : "subagent";
       return {
           type: "delegation",
           childRef,
           label,
           background: false,
           ...(task ? { summary: task } : {}),
       };
   }
   ```
2. In `translateToolStart`:
   When `shape.type === "delegation"`, attach `presentation`:
   ```typescript
   const presentation = shape.type === "delegation"
       ? {
           label: { pending: "Running subagent", completed: "Subagent completed" },
           icon: { glyph: "Bot" },
           title: String(shape.label ?? "Subagent"),
       }
       : undefined;
   ```
3. In `translateToolEnd`:
   When `item.type === "delegation"`:
   - Extract `conversationId` from `event.details.conversationId` (string or number).
   - If present, update `childRef: String(conversationId)`.
   - Update `summary` with truncated result text (up to 300 chars) or retain original task summary.
   - Retain `presentation` for `item.close`.

### Layer B: Schema Validation & Wire Conformance
Verify that all generated deltas for `subagent` (both `item.open` and `item.close`) strictly validate against `threadDeltaSchema` from `@get-bb/plugin-sdk/provider-bridge`.

---

## 3. File Budget & AP Compliance

| File | Changes | Est. Lines | Hard Limit (AP-019) | Status |
|---|---|---|---|---|
| `src/host/tool-delta-translator.ts` | Add `subagent` branch & delegation presentation | ~185 lines | 250 | PASS |
| `tests/subagent-delegation.test.ts` | Comprehensive TDD test suite for delegation cards | ~130 lines | 300 | PASS |

---

## 4. Execution Plan (TDD Steps)

1. **Step 1:** Write failing tests in `tests/subagent-delegation.test.ts` asserting:
   - `buildToolItemShape("subagent", { task: "..." })` returns `{ type: "delegation", childRef, label, background: false, summary }`.
   - `translateToolStart` emits `item.open` with `type: "delegation"` and `glyph: "Bot"` presentation.
   - `translateToolEnd` updates `childRef` from `event.details.conversationId` and sets `status: "completed"`.
   - Error cases: tool failure produces `status: "failed"` with error message.
   - All deltas pass `threadDeltaSchema.safeParse()`.
2. **Step 2:** Implement `subagent` mapping in `src/host/tool-delta-translator.ts`.
3. **Step 3:** Run `node --test tests/subagent-delegation.test.ts` to confirm tests pass.
4. **Step 4:** Run full test suite (`npm test`) and bundle build (`npm run build`).
5. **Step 5:** Commit changes as `feat(cycle-72): visual subagent delegation cards (type: "delegation")`.
