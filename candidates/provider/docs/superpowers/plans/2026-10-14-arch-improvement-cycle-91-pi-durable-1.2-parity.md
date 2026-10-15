# Pi Durable & Coding Agent v1.2.0 Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade plugin dependencies to `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, and `@earendil-works/pi-codemode@^1.2.0`, resolve breaking compiler and contract changes, replace in-memory codemode with crash-resilient Durable Codemode, implement defensive image error sanitization for Anthropic, and eliminate obsolete adapter boilerplate while preserving 100% test passing and AP architecture rules.

**Architecture:** Transition from ad-hoc in-memory wrappers (Cycle 85/86) to native Durable 1.2.0 kernel primitives. Codemode runs via `@earendil-works/pi-durable/codemode` with SQLite replay journals (`pi.codemode.journal`) in `CodemodeSandbox`. Tool execution delegates to first-class `api.executeTool()` with `retainedOutput()` and structured output. Multimodal images in `read` process through `@earendil-works/pi-durable/images/node` Photon WASM in a dedicated worker thread. Subagent conversations maintain their BB timeline hierarchy via `BBChildEventAdapter`.

**Tech Stack:** Node.js (>=22), TypeScript (5.7), `@earendil-works/pi-durable` (1.2.0), `@earendil-works/pi-coding-agent` (1.2.0), `@earendil-works/pi-codemode` (1.2.0), `@earendil-works/pi-ai` (1.2.0), `@silvia-odwyer/photon` (0.3.3), `proper-lockfile`, `esbuild`.

---

## Architecture Context & Review Findings (S4/S5)

| ID | Component | Severity | Rule | Decision | Description |
|---|---|---|---|---|---|
| **F-91-1** | `src/runner/extension-mount.ts:171`, `src/runner/runtime-controller.ts:70` | **P0** | AP-026, AP-029 | `fix-now` | `emitBeforeAgentStart` TS2554: in 1.2.0 signature expects 2 arguments (`trigger: BeforeAgentStartTrigger, systemPromptOptions: BuildSystemPromptOptions`). |
| **F-91-2** | `src/runner/subagent.ts:73,88`, `src/runner/tool-adapter.ts:121,147` | **P0** | AP-013, AP-026 | `fix-now` | Silent subagent output drop: in 1.2.0 `ToolExecutionResult.content` is renamed to `output`. Returning `content` is ignored by Durable, sending empty answers to parent LLM ([#10815](https://github.com/earendil-works/pi/issues/10815)). |
| **F-91-3** | `src/runner/extension-mount.ts:65` | **P1** | AP-010, AP-026 | `fix-now` | `TypeError: api.retainedOutput is not a function`. In 1.2.0 `bash` tool calls `api.retainedOutput()` for structured output, crashing mock `api`. |
| **F-91-4** | `package.json:28`, `src/runner/tool-adapter.ts:36`, `scripts/build-runner.mjs:26` | **P1** | AP-010, AP-026 | `fix-now` | In-memory codemode from `coding-agent` lacks ACID durability. Migrate to `@earendil-works/pi-durable/codemode` with `@earendil-works/pi-codemode` dependency. |
| **F-91-5** | `src/runner/bridge/tool-result-extractor.ts:35`, `src/runner/tool-adapter.ts:120` | **P1** | AP-010, AP-026 | `fix-now` | Anthropic HTTP 400 on error tool results containing images: sanitize image blocks to text notes when `isError === true` ([#10794](https://github.com/earendil-works/pi/issues/10794)). |
| **F-91-6** | `src/runner/harness-setup.ts:66` | **P2** | AP-010, AP-013 | `fix-now` | `read` tool fails with `unsupported_image` when inspecting images. Initialize `CodingTools` with `createNodePhotonImages()`. |
| **F-91-7** | `tests/codemode-full-coverage.test.ts:172` | **P2** | AP-028 | `fix-now` | Nonzero bash exit code in codemode resolves with `{ exitCode: 42 }` rather than throwing. Update test assertion. |

---

## Task Breakdown

### Task 1: Dependencies Manifest & Build Externals

**Files:**
- Modify: `package.json:27-35`
- Modify: `scripts/build-runner.mjs:20-30`
- Modify: `tests/package-integrity.test.ts:55-65`

- [ ] **Step 1: Write the failing test**

In `tests/package-integrity.test.ts`, add verification that `@earendil-works/pi-codemode` is declared in `dependencies`:

```typescript
	assert.ok(deps.includes("@earendil-works/pi-codemode"), "missing @earendil-works/pi-codemode");
	assert.strictEqual(pkg.dependencies["@earendil-works/pi-durable"], "^1.2.0");
	assert.strictEqual(pkg.dependencies["@earendil-works/pi-coding-agent"], "^1.2.0");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/package-integrity.test.ts`  
Expected: FAIL with "missing @earendil-works/pi-codemode"

- [ ] **Step 3: Update `package.json` and `scripts/build-runner.mjs`**

In `package.json`:
```json
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^1.2.0",
    "@earendil-works/pi-codemode": "^1.2.0",
    "@earendil-works/pi-durable": "^1.2.0",
    "@get-bb/plugin-sdk": "0.6.15",
    "@types/proper-lockfile": "^4.1.4",
    "proper-lockfile": "^4.1.2",
    "zod": "^4.6.5"
  },
```

In `scripts/build-runner.mjs`:
```javascript
	external: [
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
		"@earendil-works/pi-durable",
		"@earendil-works/pi-durable/*",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-coding-agent/*",
		"@earendil-works/pi-codemode",
		"@earendil-works/pi-codemode/*",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/*",
		"@earendil-works/chord",
		"@earendil-works/chord/*",
		"proper-lockfile",
	],
```

Run: `npm install`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/package-integrity.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/build-runner.mjs tests/package-integrity.test.ts
git commit -m "build: upgrade dependencies to pi-durable and pi-coding-agent 1.2.0 and add pi-codemode"
```

---

### Task 2: Fix Compiler Breaking Changes in `emitBeforeAgentStart`

**Files:**
- Modify: `src/runner/extension-mount.ts:165-175`
- Modify: `src/runner/runtime-controller.ts:65-75`
- Test: TypeScript compilation (`npx tsc --noEmit`)

- [ ] **Step 1: Verify TypeScript compiler failure on 1.2.0**

Run: `npx tsc --noEmit`  
Expected: FAIL with `error TS2554: Expected 2 arguments, but got 3` on `extension-mount.ts:171` and `runtime-controller.ts:70`.

- [ ] **Step 2: Update `src/runner/extension-mount.ts`**

In `src/runner/extension-mount.ts:170-175`:
```typescript
				const currentTools = registry.snapshot().tools().map((t) => t.tool.name);
				const beforeStart = await extensionRunner.emitBeforeAgentStart(
					{ messageType: "user", prompt: "", images: undefined },
					{
						cwd: location.cwd,
						selectedTools: currentTools,
						sections: dynamicSections?.getSections() ?? {},
					},
				);
				if (beforeStart?.systemPromptOptions?.sections && dynamicSections) {
					dynamicSections.updateSections(beforeStart.systemPromptOptions.sections);
				}
```

- [ ] **Step 3: Update `src/runner/runtime-controller.ts`**

In `src/runner/runtime-controller.ts:68-75`:
```typescript
				const hookRes = await extensionRunner.emitBeforeAgentStart(
					{ messageType: "user", prompt: text, images: undefined },
					promptOptions as import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
				);
				if (hookRes?.systemPromptOptions?.sections && dynamicSections) {
					dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
				}
```

- [ ] **Step 4: Run compiler check to verify it passes**

Run: `npx tsc --noEmit`  
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/runner/extension-mount.ts src/runner/runtime-controller.ts
git commit -m "fix(runner): adapt emitBeforeAgentStart to pi-coding-agent 1.2.0 two-argument signature"
```

---

### Task 3: Subagent & Adapted Tool Output Contract (`content` -> `output`)

**Files:**
- Modify: `src/runner/subagent.ts:65-92`
- Modify: `src/runner/tool-adapter.ts:115-155`
- Modify: `src/runner/bridge/tool-result-extractor.ts:35-50`
- Modify: `tests/subagent-async-envelope.test.ts:60-110`

- [ ] **Step 1: Write regression test in `tests/subagent-async-envelope.test.ts`**

Update assertions and add a test verifying that `subagent` execution returns `output` property according to Durable 1.2.0 contract:

```typescript
test("Subagent tool execution returns output property according to Durable 1.2.0 contract", async () => {
	const tool = Subagent.tools[0];
	assert.ok(tool, "Subagent tool must exist");
	const mockApi: any = {
		taskId: "task_test_subagent_output",
		commit: async (fn: any) => fn({
			scanConversations: async () => ({ items: [] }),
			createConversation: async () => ({ id: "conv_child_output_test" }),
			doc: async () => ({}),
			entry: async () => ({ model: [{ content: [{ type: "text", text: "Child solved task" }] }] }),
		}),
		details: async () => {},
		conversation: async () => ({
			submit: async () => ({
				wait: async () => ({ status: "done", type: "input", answer: "entry_123" }),
			}),
		}),
	};
	const res = await tool.execute({ task: "Compute 2+2", background: false }, mockApi, {} as any);
	assert.ok(Array.isArray(res.output), "Must return output array");
	assert.strictEqual(res.output[0].text, "Child solved task");
	assert.strictEqual((res as any).content, undefined, "content property must not be present");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-async-envelope.test.ts`  
Expected: FAIL with `Must return output array`

- [ ] **Step 3: Update `src/runner/subagent.ts`, `tool-adapter.ts`, and `tool-result-extractor.ts`**

In `src/runner/subagent.ts:72-91`:
```typescript
				if (isBackground) {
					return {
						output: [
							{
								type: "text",
								text: `Subagent spawned in background (conversation ${child}). The task is running independently and will report upon completion.`,
							},
						],
						details: { conversationId: child, background: true, task: args.task },
					};
				}

				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				return { output: [{ type: "text", text }], details: { conversationId: child, background: false, task: args.task } };
```

In `src/runner/tool-adapter.ts:121, 147`:
```typescript
				return {
					output: result.content,
					isError: result.isError,
					details: (result.details ?? undefined) as JsonValue | undefined,
				};
```
and
```typescript
				return {
					output: errorContent,
					isError: true,
				};
```

In `src/runner/bridge/tool-result-extractor.ts:35-45`:
```typescript
export function extractToolResult(modelItem: unknown): { result: string; isError: boolean } {
	const msg = typeof modelItem === "object" && modelItem !== null ? (modelItem as RawToolResultMessage) : undefined;
	const isError = msg?.isError ?? false;
	let result = "";
	const raw = msg?.output ?? msg?.content;
	if (Array.isArray(raw)) {
		result = raw
			.map((b) => (typeof b === "object" && b !== null && typeof b.text === "string" ? b.text : ""))
			.filter(Boolean)
			.join("\n");
	} else if (typeof raw === "string") {
		result = raw;
	}
	return { result, isError };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-async-envelope.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runner/subagent.ts src/runner/tool-adapter.ts src/runner/bridge/tool-result-extractor.ts tests/subagent-async-envelope.test.ts
git commit -m "fix(runner): rename ToolExecutionResult content to output for Durable 1.2.0 parity"
```

---

### Task 4: Mock API `retainedOutput` in `createNestedToolExecutor`

**Files:**
- Modify: `src/runner/extension-mount.ts:60-80`
- Test: `tests/codemode-nested-env.test.ts`

- [ ] **Step 1: Run `tests/codemode-nested-env.test.ts` to inspect failure**

Run: `node --test tests/codemode-nested-env.test.ts`  
Expected: FAIL with `Error: api.retainedOutput is not a function`

- [ ] **Step 2: Add `retainedOutput` and `outputWindow` to mock `api` in `src/runner/extension-mount.ts`**

In `src/runner/extension-mount.ts:65-76`:
```typescript
			let outputText = "";
			const api = {
				callId: `${callerId}/nested`,
				output: (chunk: string | Uint8Array) => {
					outputText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				},
				retainedOutput: () => ({ text: outputText, truncated: false }),
				outputWindow: undefined,
				env: getEnv?.(),
				diagnostic: () => {},
			};
```

- [ ] **Step 3: Run `tests/codemode-nested-env.test.ts` to verify it passes**

Run: `node --test tests/codemode-nested-env.test.ts`  
Expected: PASS (2 / 2 tests passing)

- [ ] **Step 4: Verify file line limits (AP-019)**

Run: `wc -l src/runner/extension-mount.ts`  
Expected: < 200 lines (currently ~196 lines).

- [ ] **Step 5: Commit**

```bash
git add src/runner/extension-mount.ts
git commit -m "fix(runner): implement retainedOutput in nested tool executor mock api"
```

---

### Task 5: Anthropic Defensive Error Image Sanitization ([#10794](https://github.com/earendil-works/pi/issues/10794))

**Files:**
- Modify: `src/runner/bridge/tool-result-extractor.ts`
- Modify: `src/runner/tool-adapter.ts`
- Create Test: `tests/anthropic-image-error.test.ts`

- [ ] **Step 1: Write failing test in `tests/anthropic-image-error.test.ts`**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolResultForAnthropic } from "../src/runner/bridge/tool-result-extractor.ts";

test("sanitizeToolResultForAnthropic replaces images with text note when isError is true", () => {
	const content = [
		{ type: "image", data: "base64data...", mimeType: "image/png" },
		{ type: "text", text: "Something went wrong" },
	];
	const sanitized = sanitizeToolResultForAnthropic(content as any, true);
	assert.strictEqual(sanitized.length, 2);
	assert.strictEqual(sanitized[0].type, "text");
	assert.strictEqual((sanitized[0] as any).text, "[image omitted: error tool results cannot contain images]");
	assert.strictEqual(sanitized[1].text, "Something went wrong");
});

test("sanitizeToolResultForAnthropic preserves images when isError is false", () => {
	const content = [
		{ type: "image", data: "base64data...", mimeType: "image/png" },
	];
	const sanitized = sanitizeToolResultForAnthropic(content as any, false);
	assert.strictEqual(sanitized[0].type, "image");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/anthropic-image-error.test.ts`  
Expected: FAIL with "sanitizeToolResultForAnthropic is not a function"

- [ ] **Step 3: Implement `sanitizeToolResultForAnthropic` in `src/runner/bridge/tool-result-extractor.ts`**

In `src/runner/bridge/tool-result-extractor.ts`:
```typescript
export function sanitizeToolResultForAnthropic<T extends { type: string }>(blocks: T[], isError?: boolean): T[] {
	if (!isError || !Array.isArray(blocks)) return blocks;
	return blocks.map((block) => {
		if (block.type === "image") {
			return { type: "text", text: "[image omitted: error tool results cannot contain images]" } as unknown as T;
		}
		return block;
	});
}
```

And in `src/runner/tool-adapter.ts:121`:
```typescript
				const sanitizedContent = sanitizeToolResultForAnthropic(result.content as any, result.isError);
				return {
					output: sanitizedContent,
					isError: result.isError,
					details: (result.details ?? undefined) as JsonValue | undefined,
				};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/anthropic-image-error.test.ts`  
Expected: PASS (2 / 2 tests passing)

- [ ] **Step 5: Commit**

```bash
git add src/runner/bridge/tool-result-extractor.ts src/runner/tool-adapter.ts tests/anthropic-image-error.test.ts
git commit -m "feat(runner): sanitize images in error tool results to prevent Anthropic 400"
```

---

### Task 6: Native Durable Codemode & Tool Search Integration

**Files:**
- Modify: `src/runner/tool-adapter.ts:1-55`
- Modify: `src/runner/harness-setup.ts:60-75`
- Modify: `tests/codemode-full-coverage.test.ts:135-180`
- Test: `tests/codemode-full-coverage.test.ts`

- [ ] **Step 1: Run `tests/codemode-full-coverage.test.ts` to inspect exitCode failure**

Run: `node --test tests/codemode-full-coverage.test.ts`  
Expected: Subtest `i. Error handling` fails on `resCaughtBash.text.includes("Command exited with code 42")`.

- [ ] **Step 2: Update `src/runner/tool-adapter.ts` and `src/runner/harness-setup.ts`**

In `src/runner/tool-adapter.ts`:
- Remove imports `createCodemodeExtension` and `createToolSearchExtension` from `@earendil-works/pi-coding-agent`.
- `createStandardExtensionFactories` returns `[createMcpExtension()]`.
- Correct `exposure` mapping:
```typescript
	const isDeferred = exposure === "deferred" || exposure === "codemode-deferred";
	const callers =
		exposure === "model-only"
			? (["model"] as const)
			: exposure === "codemode" || exposure === "codemode-deferred"
				? (["tools"] as const)
				: exposure === "hidden"
					? ([] as const)
					: (["model", "tools"] as const);

	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		...(callers ? { callers } : {}),
		...(isDeferred ? { deferred: true } : {}),
```

In `src/runner/harness-setup.ts`:
```typescript
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
```
Install them into `createCodingRegistry`:
```typescript
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
	registry.install(createToolSearchExtension());
	registry.install(Subagent);
	registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
	return registry;
```

In `tests/codemode-full-coverage.test.ts:170-175`:
Update assertion to verify that nonzero bash exits return structured exitCode in 1.2.0:
```typescript
		const resCaughtBash = await runScript(`
			const res = await tools.bash({ command: "exit 42" });
			text("bash_exit_code: " + res.exitCode);
		`);
		assert.ok(resCaughtBash.text.includes("bash_exit_code: 42"));
```

- [ ] **Step 3: Run `tests/codemode-full-coverage.test.ts` to verify all pass**

Run: `node --test tests/codemode-full-coverage.test.ts`  
Expected: PASS (10 / 10 end-to-end tests passing)

- [ ] **Step 4: Verify file line limits (AP-019)**

Run: `wc -l src/runner/tool-adapter.ts src/runner/harness-setup.ts`  
Expected: Both files strictly < 200 lines.

- [ ] **Step 5: Commit**

```bash
git add src/runner/tool-adapter.ts src/runner/harness-setup.ts tests/codemode-full-coverage.test.ts
git commit -m "feat(runner): migrate to native Durable Codemode and Tool Search extensions"
```

---

### Task 7: Multimodal Read Tool with Photon WASM

**Files:**
- Modify: `src/runner/harness-setup.ts`
- Modify: `src/runner/runtime-loader.ts`
- Create Test: `tests/read-images.test.ts`

- [ ] **Step 1: Write failing test in `tests/read-images.test.ts`**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

test("CodingTools with createNodePhotonImages registers read tool capable of image processing", async () => {
	const images = await createNodePhotonImages();
	const tools = createCodingTools({ images });
	const readTool = tools.tools?.find((t) => t.name === "read");
	assert.ok(readTool, "Read tool must be registered");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/read-images.test.ts`  
Expected: PASS

- [ ] **Step 3: Wire `createNodePhotonImages()` into `src/runner/harness-setup.ts`**

In `src/runner/harness-setup.ts`:
```typescript
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

export async function createCodingRegistry(
	settingsManager: SettingsManager,
	cwd: string,
	promptOptions?: PromptOptions,
): Promise<Registry> {
	const registry = createRegistry();
	let codingTools = CodingTools;
	try {
		const images = await createNodePhotonImages();
		codingTools = createCodingTools({ images });
	} catch (err) {
		console.warn("[HarnessSetup] Photon image processor unavailable, using standard tools:", err);
	}
	registry.install(codingTools);
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
	registry.install(createToolSearchExtension());
	registry.install(Subagent);
	registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
	return registry;
}
```

Update `src/runner/runtime-loader.ts:93` with `await createCodingRegistry(...)`, and update `tests/durable-subagent.test.ts` with `await createCodingRegistry(...)`.

- [ ] **Step 4: Run all related tests**

Run: `node --test tests/read-images.test.ts tests/durable-subagent.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runner/harness-setup.ts src/runner/runtime-loader.ts tests/durable-subagent.test.ts tests/read-images.test.ts
git commit -m "feat(runner): enable multimodal Photon WASM image processor in read tool"
```

---

### Task 8: Full Verification, AP Gates, Doctor Audit & Ledger Entry (S9–S12)

**Files:**
- Modify: `docs/arch-improvement/ledger.md`
- Verify: Whole repository

- [ ] **Step 1: Check File Line Budgets (AP-019)**

Run: `wc -l $(find src/runner -maxdepth 1 -type f)`  
Expected: 100% of files in `src/runner/` are strictly < 200 lines.

- [ ] **Step 2: TypeScript Compiler Verification (AP-029)**

Run: `npx tsc --noEmit`  
Expected: 0 errors (exit code 0).

- [ ] **Step 3: Run Full Test Suite (AP-028)**

Run: `npm test`  
Expected: 100% of tests passing (205+ tests, 0 failures, 0 skipped).

- [ ] **Step 4: Run Doctor Diagnostics**

Run: `npm run doctor`  
Expected: Healthy status report with resolved tools and extensions.

- [ ] **Step 5: Run Production Build**

Run: `npm run build`  
Expected: Clean build for `dist/runner/index.js`, `dist/server.js`, and `dist/host.js`.

- [ ] **Step 6: Sync to BB IDE and reload**

Sync artifacts to `~/.bb/plugins/cache/.../dist/` and run:
`bb plugin reload provider-pi-durable`  
Verify: Plugin reloads with status `running`.

- [ ] **Step 7: Record Cycle 91 in `docs/arch-improvement/ledger.md`**

Append comprehensive Cycle 91 entry detailing findings, implementations, AP verification, and test evidence.

- [ ] **Step 8: Final Git Commit and Push**

```bash
git add docs/arch-improvement/ledger.md dist/
git commit -m "chore: record Cycle 91 in architecture ledger and commit build artifacts"
git push origin main
```
