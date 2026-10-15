# Implementation Plan: Arch Improvement Cycle 74 (Pi Extension Lifecycle & MCP Engine Parity)

**Cycle:** 74  
**Target Release:** `v0.2.20`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences:** D-16, D-17, D-18, D-19 (AP-010, AP-012, AP-019, AP-026, AP-029)  

---

## 1. Problem Statement & Primary Sources

### 1.1 The MCP Startup Race Bug (D-16)
In Beyond Boundaries IDE:
- Fast Node-based MCP servers (e.g. `telegram-mcp`, starting in ~200 ms) successfully connect and register their tools (`mcp__telegram__*`) in the Durable `Registry`.
- Heavy Bun/PostgreSQL-based MCP servers (e.g. `gbrain`, starting in ~3.5–4.5 s due to runtime initialization and database connection pool establishment) fail to appear either in declared tools or in `codemode` during the initial turns.
- **Root Cause:** In `src/runner/extension-mount.ts`, `setupExtensionRunner` emits `session_start`, which triggers background MCP connections (`pending = Promise.all(...)`) without awaiting them. The runner signals `ready: true` immediately, causing the first turn to run before direct MCP servers settle.
- **Primary Source Parity:** In canonical `@earendil-works/pi-coding-agent` (`src/extensions/mcp/index.ts:1153`), the runtime invokes `waitForDirectServers(ctx)` with a configurable timeout (default 10 s), holding the first turn until all servers configured with `direct` tools or direct tool exposure are connected and registered.

### 1.2 Static System Prompt & Missing Dynamic Extension Sections (D-17)
- In the plugin, `createPiPrompt` (`src/runner/prompt.ts`) constructs the system prompt statically from tools, rules, `AGENTS.md`, and skills.
- Canonical Pi extensions augment the prompt per turn via the `before_agent_start` event (`event.systemPromptOptions.sections`):
  1. MCP Extension (`src/extensions/mcp/index.ts:1175`): Injects the `mcp_servers` section describing reachable servers and exposure modes.
  2. Ambient Memory Extension (`.pi/extensions/gbrain.ts`): Injects user context and hot memory cache with zero latency.
- **Root Cause:** In `bb-plugin-provider-pi-durable`, the runner never emits `before_agent_start`, so dynamic prompt sections are permanently lost.

### 1.3 Missing Tool Execution Hooks for Lazy Waiting & Guardrails (D-18)
- In canonical Pi, `codemode` scripts that access deferred or background MCP servers trigger the `tool_call` event.
- In `src/extensions/mcp/index.ts:1190`, the MCP extension intercepts `tool_call`:
  ```typescript
  if (isCodemodeTool(tool)) {
      const { code } = event.input;
      waiting = readyServers.filter((server) => scriptNeedsServer(source, server.entry.name));
  }
  await waitForServers(waiting, ctx.signal);
  ```
  This guarantees that even background-connecting servers are waited for on-demand when a script references them.
- Furthermore, guardrail extensions (such as `skill-guardian.ts`) hook `tool_call` to enforce workspace safety invariants.
- **Root Cause:** In `bb-plugin-provider-pi-durable`, `createNestedToolExecutor` and `adaptExtensionTool` execute tools without emitting `tool_call` and `tool_result` to `extensionRunner`.

### 1.4 Silent Swallowing of MCP Diagnostics and UI Notices (D-19)
- When an MCP server requires authentication (`needs-auth`), encounters an invalid configuration, or fails to connect, the MCP extension invokes `ctx.ui.notify(message, level)`.
- In `src/runner/extension-bridge.ts`, `setupExtensionRunner` does not configure `runner.setUIContext()`. All notifications fall back to `noOpUIContext` and are silently discarded.

---

## 2. Technical Architecture & Invariant Specifications

### 2.1 The Four Territories Boundary (AP-010)
- **Territory 2 (Pi Durable Engine):** Continues to execute ACID FSM tasks and SQLite storage.
- **Territory 3 (Pi Coding Agent Ecosystem):** `ExtensionRunner` manages extension lifecycles and tool schemas.
- **Territory 4 (bb-plugin-provider-pi-durable):** Wires the lifecycle bridge between Durable turn submissions and `ExtensionRunner` hooks without taking foreign domain ownership.

### 2.2 AP-019 File Size & Modularity Invariant
All files modified or created must remain strictly under 200 lines (soft limit 150, hard limit 250):
- `src/runner/extension-mount.ts`: Current 96 lines → Target <= 140 lines.
- `src/runner/extension-bridge.ts`: Current 136 lines → Target <= 160 lines.
- `src/runner/prompt.ts`: Current 152 lines → Target <= 180 lines.

---

## 3. Step-by-Step Implementation Slices

### Slice 1: Direct MCP Readiness Synchronization on Boot (`src/runner/extension-mount.ts`)
- In `mountExtensionBridge`:
  1. Add an optional `readyTimeoutMs` parameter (default: 8000 ms).
  2. After `session_start` emission in `setupExtensionRunner`, expose a readiness check helper:
     Wait for any registered extension tool matching `hasDirectTools` or poll `getAllRegisteredTools()` until quiet period (e.g. 200 ms without new tool registrations, or timeout).
  3. Ensure that `syncToolsToRegistry` completes and installs all initially available tools before resolving the mount bridge.
  4. Ensure fail-open semantics: if timeout is reached, log warning via notice channel and proceed with already registered tools (never block the runner indefinitely).

### Slice 2: Dynamic System Prompt Extension Hook (`src/runner/prompt.ts`)
- Update `createPiPrompt`:
  1. Accept `getExtensionRunner?: () => ExtensionRunner | undefined`.
  2. Before constructing prompt sections in `buildSections(input)`:
     If `extensionRunner` is active, construct a synthetic `systemPromptOptions: { sections: Record<string, string> }` and emit `{ type: "before_agent_start", systemPromptOptions }`.
  3. Merge any dynamic sections populated by extensions (e.g., `mcp_servers`, ambient context) directly into Durable `PromptSection` entries.

### Slice 3: Tool Execution Lifecycle Forwarding (`src/runner/extension-mount.ts`, `extension-bridge.ts`)
- In `createNestedToolExecutor` and `adaptExtensionTool`:
  1. Before executing target tool: emit `{ type: "tool_call", toolName: name, input: args, toolCallId: callerId }` via `extensionRunner.emit()`.
  2. Await `tool_call` handlers (enabling MCP's `waitForServers` and guardrail interceptors).
  3. Execute tool implementation.
  4. After execution: emit `{ type: "tool_result", toolName: name, result: res, toolCallId: callerId }`.

### Slice 4: Bridge Diagnostic & Notice Integration (`src/runner/extension-bridge.ts`)
- In `setupExtensionRunner`:
  1. Accept an optional `onNotice?: (level: "info" | "warning" | "error", message: string) => void`.
  2. Call `runner.setUIContext({ notify: (msg, level) => onNotice?.(level, msg) })`.
  3. In `src/runner/index.ts`: wire `onNotice` to `sendToBridge({ kind: "notice", level, message })`.

### Slice 5: Deterministic Unit & Integration Tests (`tests/extension-lifecycle-mcp.test.ts`)
- Implement comprehensive automated tests:
  1. Test `before_agent_start` dynamic section enrichment into `createPiPrompt`.
  2. Test `tool_call` lifecycle emission and arguments passing.
  3. Test `setUIContext` notification forwarding to bridge notice handler.
  4. Test startup readiness synchronization with slow mock MCP server without hanging.

---

## 4. Verification & Success Criteria

1. **Test Suite:** All 85 existing tests + new Cycle 74 tests pass cleanly (`npm test`).
2. **AP-019 Modularity:** `wc -l src/**/*.ts` confirms all files under 200 lines.
3. **AP-029 Typing:** Zero `as any` casts in modified modules.
4. **Live Verification:** 
   - `codemode` with `searchTools('gbrain')` and `tools.mcp__gbrain__*` discovers all 35 GBrain tools.
   - Live Telegram and GBrain MCP tools coexist deterministically in `ALL_TOOLS`.
   - Prompt contains dynamic `mcp_servers` section.
