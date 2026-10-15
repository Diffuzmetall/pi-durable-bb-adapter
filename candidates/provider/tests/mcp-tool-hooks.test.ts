import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool, setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { ModelRuntime, type ToolDefinition, type Extension } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineTool } from "@earendil-works/pi-durable";

test("D-18: adaptExtensionTool invokes tool_call and tool_result extension hooks", async () => {
	let toolCallEmitted = false;
	let toolResultEmitted = false;

	const mockRunner = {
		hasHandlers: (evt: string) => evt === "tool_call" || evt === "tool_result",
		emitToolCall: async (evt: any) => {
			toolCallEmitted = true;
			assert.equal(evt.toolName, "search_tool");
			if (evt.input.query === "block_me") {
				return { block: true, reason: "guardrail_violation" };
			}
			assert.equal(evt.input.query, "hello");
			return undefined;
		},
		emitToolResult: async (evt: any) => {
			toolResultEmitted = true;
			assert.equal(evt.toolName, "search_tool");
			assert.deepEqual(evt.content, [{ type: "text", text: "search_ok" }]);
		},
	} as any;

	const toolDef: ToolDefinition = {
		name: "search_tool",
		description: "search",
		parameters: Type.Object({ query: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "search_ok" }] }),
	};

	const adapted = adaptExtensionTool(
		toolDef,
		async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		undefined,
		() => mockRunner,
	);

	// Normal execution
	const res = await adapted.execute({ query: "hello" } as any, { callId: "c_1", output: () => {} } as any, {} as any);
	assert.equal(toolCallEmitted, true);
	assert.equal(toolResultEmitted, true);
	assert.deepEqual(res.output, [{ type: "text", text: "search_ok" }]);

	// Blocked by hook
	const blockedRes = await adapted.execute({ query: "block_me" } as any, { callId: "c_2", output: () => {} } as any, {} as any);
	assert.equal(blockedRes.isError, true);
	assert.ok(String(blockedRes.output?.[0]?.text).includes("guardrail_violation"));
});

test("D-18: createNestedToolExecutor invokes tool_call and tool_result on nested calls", async () => {
	const registry = createRegistry();
	registry.install({
		name: "base-tools",
		tools: [
			defineTool({
				name: "echo_tool",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (args: any) => ({ output: [{ type: "text", text: `echo:${args.text}` }] }),
			}),
		],
	});

	let nestedCallEmitted = false;
	let nestedResultEmitted = false;
	const mockRunner = {
		hasHandlers: (evt: string) => evt === "tool_call" || evt === "tool_result",
		emitToolCall: async (evt: any) => {
			nestedCallEmitted = true;
			assert.equal(evt.toolName, "echo_tool");
			assert.equal(evt.parentToolCallId, "caller_123");
			return undefined;
		},
		emitToolResult: async (evt: any) => {
			nestedResultEmitted = true;
			assert.equal(evt.toolName, "echo_tool");
			assert.equal(evt.parentToolCallId, "caller_123");
		},
	} as any;

	const executor = createNestedToolExecutor(registry, () => mockRunner);
	const result = await executor("caller_123", "echo_tool", { text: "nested_test" });

	assert.equal(nestedCallEmitted, true);
	assert.equal(nestedResultEmitted, true);
	assert.equal(result.isError, false);
	assert.deepEqual(result.result.content, [{ type: "text", text: "echo:nested_test" }]);
});

test("D-19: setupExtensionRunner forwards notify notices via onNotice callback", async () => {
	const notices: Array<{ level: string; message: string }> = [];
	const mockExtension: Extension = {
		name: "notifying-ext",
		handlers: new Map(),
		tools: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	const runner = await setupExtensionRunner({
		extensions: [mockExtension],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
		cwd: process.cwd(),
		modelRuntime: await ModelRuntime.create(),
		executeToolFn: async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		onNotice: (level, message) => notices.push({ level, message }),
	});

	assert.ok(runner.hasUI());
	runner.getUIContext().notify("Server connection timed out", "warning");

	assert.equal(notices.length, 1);
	assert.deepEqual(notices[0], { level: "warning", message: "Server connection timed out" });
});
