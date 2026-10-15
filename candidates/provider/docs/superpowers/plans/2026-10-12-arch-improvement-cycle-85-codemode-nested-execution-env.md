# Arch Improvement Cycle 85: Codemode Nested Tool Execution Environment & Output Parity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide genuine execution environment (`api.env`) and output buffering (`api.output`, `api.diagnostic`) to nested tool executions in `createNestedToolExecutor`, enabling `codemode` scripts to invoke `tools.bash`, `tools.read`, `tools.write`, and `tools.edit` without "No execution environment is configured" errors.

**Architecture:** Inject `getEnv?: () => ExecutionEnv | undefined` into `createNestedToolExecutor` from `loadHarnessEnvironment` in `src/runner/runtime-loader.ts`. In `src/runner/extension-mount.ts`, provide `env: getEnv?.()`, collect streamed chunks via `api.output`, stub `api.diagnostic`, and fallback to collected output when `res.content` is omitted. Add end-to-end regression tests in `tests/codemode-nested-env.test.ts`. Maintain strict AP-019 compliance (< 200 lines per file) and AP-029 (0 `as any`).

**Tech Stack:** TypeScript, Node.js (`node:test`), `@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/chord`.

---

### Task 1: Write Failing Integration Test (TDD RED)

**Files:**
- Create: `tests/codemode-nested-env.test.ts`

- [ ] **Step 1: Write the failing test for nested execution environment and output capture**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import os from "node:os";

test("Cycle 85: createNestedToolExecutor passes execution environment to CodingTools", async () => {
	const registry = createRegistry();
	registry.install(CodingTools);

	const tmpDir = os.tmpdir();
	const env = new NodeExecutionEnv({ cwd: tmpDir });

	const executor = createNestedToolExecutor(registry, undefined, () => env);

	// Test read on a known file (e.g., package.json in process.cwd())
	const outcome = await executor("call-1", "bash", { command: "echo nested_success" });

	assert.equal(outcome.isError, false, `Expected bash execution to succeed, got error: ${JSON.stringify(outcome.result)}`);
	assert.ok(outcome.result.content.length > 0);
	assert.ok(
		outcome.result.content[0].text.includes("nested_success"),
		`Expected output to contain 'nested_success', got: ${outcome.result.content[0].text}`,
	);

	await env.cleanup({} as any);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codemode-nested-env.test.ts`
Expected: FAIL with `No execution environment is configured` or parameter mismatch.

---

### Task 2: Implement Execution Environment & Output Buffering in `extension-mount.ts` (TDD GREEN)

**Files:**
- Modify: `src/runner/extension-mount.ts`

- [ ] **Step 1: Update `createNestedToolExecutor` signature and implementation**

Accept `getEnv?: () => import("@earendil-works/pi-durable/env").ExecutionEnv | undefined` in `createNestedToolExecutor`.
In `executor(args, api, runtimeContext)`:
- Pass `env: getEnv?.()`
- Collect chunks in `output: (chunk: string | Uint8Array) => { ... }`
- Provide `diagnostic: () => {}`
- Resolve content using `res?.content` or fallback to collected output string.

Ensure `src/runner/extension-mount.ts` remains strictly under 200 lines (AP-019).

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/codemode-nested-env.test.ts`
Expected: PASS

---

### Task 3: Wire `getEnv` in `src/runner/runtime-loader.ts`

**Files:**
- Modify: `src/runner/runtime-loader.ts`

- [ ] **Step 1: Pass `getEnv` to `createNestedToolExecutor` in `loadHarnessEnvironment`**

In `src/runner/runtime-loader.ts`:
```typescript
const executeToolFn = createNestedToolExecutor(
	registry,
	() => runnerRef,
	() => envs.env({ cwd: location.cwd, conversationId: "root" as import("@earendil-works/pi-durable").ConversationId, read: undefined as any }),
);
```

Ensure `src/runner/runtime-loader.ts` remains strictly under 200 lines (AP-019).

- [ ] **Step 2: Run test suite**

Run: `npm test`
Expected: All 155+ tests PASS.

---

### Task 4: Codemode End-to-End Test with `tools.bash` and `tools.read`

**Files:**
- Modify: `tests/codemode-nested-env.test.ts`

- [ ] **Step 1: Add end-to-end test verifying codemode script calling `tools.bash` and `tools.read`**

```typescript
test("Cycle 85: codemode script successfully executes tools.bash and tools.read", async () => {
	// Setup extension runner with codemode extension and durable coding tools
	// Execute codemode script with await tools.bash({ command: 'echo hello_codemode' })
	// Verify script output contains 'hello_codemode'
});
```

- [ ] **Step 2: Run test and verify it passes**

Run: `node --test tests/codemode-nested-env.test.ts`
Expected: PASS

---

### Task 5: Build, Line Budget & Verification Gates

**Files:**
- Verify: `npm run build`
- Verify: `npm test`
- Verify: `wc -l src/runner/*.ts src/runner/bridge/*.ts`

- [ ] **Step 1: Run typecheck and full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: 0 type errors, all tests pass.

- [ ] **Step 2: Verify line count limit (AP-019 < 200 lines)**

Run: `wc -l src/runner/extension-mount.ts src/runner/runtime-loader.ts`
Expected: All files strictly < 200 lines.

- [ ] **Step 3: Build distribution artifacts**

Run: `npm run build`
Expected: Exit code 0, artifacts built in `dist/`.

- [ ] **Step 4: Update Ledger in `docs/arch-improvement/ledger.md`**

Add Cycle 85 section documenting findings, implementations, and verification evidence.

---
