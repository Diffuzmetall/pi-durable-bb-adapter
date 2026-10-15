# Arch Improvement Cycle 60: Transparent Extension Loader & User Policy Invariant

**Goal:** Establish the "Thin Bridge & User Policy Invariant" by wiring Pi's standard built-in extension factories (`createCodemodeExtension`, `createMcpExtension`, `createToolSearchExtension`) and user extensions into `DefaultResourceLoader`, seamlessly exposing user-configured tools and MCP servers to the Pi Durable `Registry` while keeping the provider plugin thin, decoupled, and unopinionated.

---

## 1. Problem Statement & Root Cause

### Finding F-60-1 (AP-010, AP-013, AP-026)
- **Problem:** When running under `provider-pi-durable`, users cannot use tools from external MCP servers configured in `~/.pi/agent/mcp.json` or project-local `.pi/mcp.json`, nor can they use `codemode` or user extensions installed in `~/.pi/agent/extensions/`. The agent is artificially constrained to the 4 base tools (`read`, `bash`, `edit`, `write`), despite Pi's ecosystem offering extensive tooling.
- **Root Cause:** In `src/runner/runtime-loader.ts`, `DefaultResourceLoader` was instantiated without `extensionFactories`. Furthermore, `ExtensionRunner` was never initialized or lifecycle-bound (`session_start` event was omitted), and discovered extension tools were never bridged into the Durable `Registry`.
- **Architectural Policy Invariant:** The plugin must NOT become a "fat god-plugin" that hardcodes tools or forces arbitrary connections. It must serve as a **thin, transparent protocol adapter**:
  - The core durable engine handles persistence (ACID SQLite WAL, FSM, checkpoints).
  - The user decides what to connect via standard `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, and `.pi/mcp.json`.
  - The provider simply exposes Pi's standard extension factories to `DefaultResourceLoader` and bridges any active tools into the Durable `Registry`.

---

## 2. Architecture & Design

### Components

1. **`src/runner/extension-bridge.ts` (New Module, < 200 lines):**
   - `createStandardExtensionFactories()`: returns `[createCodemodeExtension({ mode: "auto" }), createToolSearchExtension(), createMcpExtension()]`.
   - `setupExtensionRunner(options)`: instantiates `ExtensionRunner`, binds core actions (`bindCore`) with a nested `executeTool` router, and emits `{ type: "session_start" }`.
   - `adaptExtensionTool(toolDef, runner)`: converts an `@earendil-works/pi-coding-agent` `ToolDefinition` into a `@earendil-works/pi-durable` `ToolRegistration` using `defineTool`.
   - `installExtensionTools(registry, tools)`: installs adapted tools as a dynamic extension in Durable's `Registry`.

2. **`src/runner/runtime-loader.ts` (Update, < 150 lines):**
   - Passes `createStandardExtensionFactories()` to `DefaultResourceLoader`.
   - Initializes the extension bridge after `resourceLoader.reload()`.
   - Mounts the adapted extension tools into `registry`.

---

## 3. Architecture Rules Compliance

- **AP-010 (Modular Monolith & Ports/Adapters):** All extension runner bridging is isolated in `src/runner/extension-bridge.ts`.
- **AP-012 (Fail-Fast & Explicit Error Contracts):** Extension tool errors propagate cleanly through `AgentToolResult.isError` and Durable's `ToolExecutionResult`.
- **AP-013 (Data Integrity without Fakes):** Tools are executed directly via genuine Pi `ExtensionRunner` and actual MCP client processes, not mocked stubs.
- **AP-019 (File Size Limits & Modularity):**
  - `src/runner/extension-bridge.ts`: < 180 lines.
  - `src/runner/runtime-loader.ts`: < 150 lines.
- **AP-026 (DTO Boundaries & Strict Schema Validation):** TypeBox schemas from `ToolDefinition.parameters` are preserved and verified by `ToolTask`.
- **AP-028 (Testing Strategy & Determinism):** Deterministic unit tests in `tests/extension-bridge.test.ts`.

---

## 4. Implementation Steps (TDD)

1. **Step 1: Write Unit Tests (`tests/extension-bridge.test.ts`)**
   - Test that `createStandardExtensionFactories()` returns standard factories.
   - Test that `setupExtensionRunner()` loads tools and handles `executeTool` dispatching.
   - Test that `adaptExtensionTool()` correctly bridges `ToolDefinition` into `ToolRegistration`.
2. **Step 2: Create `src/runner/extension-bridge.ts`**
   - Implement the bridge functions and nested execution router.
3. **Step 3: Update `src/runner/runtime-loader.ts`**
   - Integrate `extension-bridge.ts` into `loadHarnessEnvironment`.
4. **Step 4: Verify & Build**
   - Run `npm test` across all suites.
   - Run `node scripts/build-runner.mjs && bb plugin build`.
   - Reload plugin in BB IDE (`bb plugin reload provider-pi-durable`).
5. **Step 5: Ledger & Releases**
   - Update `docs/arch-improvement/ledger.md` (Cycle 60).
   - Bump version to `0.2.5`.
   - Commit, tag `v0.2.5`, and release.
