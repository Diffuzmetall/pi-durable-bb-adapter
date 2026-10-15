import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { createRegistry } from "@earendil-works/pi-durable";
import {
	createStandardExtensionFactories,
	adaptExtensionTool,
	installExtensionTools,
	hasOutput,
} from "../src/runner/extension-bridge.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("Extension Bridge (Cycle 60)", () => {
	it("createStandardExtensionFactories returns 1 built-in factory (MCP)", () => {
		const factories = createStandardExtensionFactories();
		assert.equal(Array.isArray(factories), true);
		assert.strictEqual(factories.length, 1);
		for (const factory of factories) {
			assert.equal(typeof factory, "function");
		}
	});

	it("adaptExtensionTool maps ToolDefinition to Durable ToolRegistration", async () => {
		let executed = false;
		const mockToolDef: ToolDefinition = {
			name: "mock_search",
			label: "Mock Search",
			description: "Simulates search",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (toolCallId, params) => {
				executed = true;
				return {
					content: [{ type: "text", text: `Found result for: ${(params as any).query}` }],
					details: { matchCount: 1 },
				};
			},
		};

		const durableTool = adaptExtensionTool(mockToolDef, () => {
			throw new Error("No nested executeTool in this test");
		});

		assert.equal(durableTool.name, "mock_search");
		assert.equal(durableTool.description, "Simulates search");
		assert.ok(durableTool.parameters);

		// Execute the adapted tool
		const result = await durableTool.execute(
			{ query: "pi durable" } as any,
			{
				callId: "call_test_123",
				output: () => {},
			} as any,
			{} as any,
		);

		assert.equal(executed, true);
		assert.deepEqual(result.output, [{ type: "text", text: "Found result for: pi durable" }]);
		assert.deepEqual(result.details, { matchCount: 1 });
		assert.equal(result.isError, undefined);
	});

	it("adaptExtensionTool preserves isError and error details", async () => {
		const errorToolDef: ToolDefinition = {
			name: "failing_tool",
			label: "Failing Tool",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "Failed to connect to service" }],
				isError: true,
				details: { code: "ECONNREFUSED" },
			}),
		};

		const durableTool = adaptExtensionTool(errorToolDef, () => {
			throw new Error("No nested executeTool");
		});

		const result = await durableTool.execute(
			{} as any,
			{
				callId: "call_err_1",
				output: () => {},
			} as any,
			{} as any,
		);

		assert.equal(result.isError, true);
		assert.deepEqual(result.output, [{ type: "text", text: "Failed to connect to service" }]);
		assert.deepEqual(result.details, { code: "ECONNREFUSED" });
	});

	it("setupExtensionRunner supports lifecycle startup and shutdown", async () => {
		const { DefaultResourceLoader, getAgentDir, SettingsManager, ModelRuntime } =
			await import("@earendil-works/pi-coding-agent");
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(process.cwd()),
		});
		await loader.reload();
		const { extensions, runtime } = loader.getExtensions();

		let shutdownEmitted = false;
		const mockExtension: any = {
			name: "mock-ext",
			handlers: new Map([
				["session_shutdown", [() => { shutdownEmitted = true; }]],
			]),
		};

		const { setupExtensionRunner } = await import("../src/runner/extension-bridge.ts");
		const runner = await setupExtensionRunner({
			extensions: [...extensions, mockExtension],
			runtime,
			cwd: process.cwd(),
			modelRuntime: await ModelRuntime.create(),
			executeToolFn: async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		});

		assert.ok(runner);
		await runner.emit({ type: "session_shutdown", reason: "shutdown" });
		assert.equal(shutdownEmitted, true, "session_shutdown event must trigger extension handlers");
	});

	it("hasOutput accurately identifies objects with output method (AP-029)", () => {
		assert.equal(hasOutput(null), false);
		assert.equal(hasOutput(undefined), false);
		assert.equal(hasOutput("string"), false);
		assert.equal(hasOutput(123), false);
		assert.equal(hasOutput({}), false);
		assert.equal(hasOutput({ output: "not a function" }), false);
		assert.equal(hasOutput({ output: () => {} }), true);
	});

	it("streams output to api.output when present and ignores when absent", async () => {
		const streamingToolDef: ToolDefinition = {
			name: "streaming_tool",
			label: "Streaming Tool",
			description: "Streams progress updates",
			parameters: Type.Object({}),
			execute: async (_callId, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "step 1... " }] });
				onUpdate?.({ content: [{ type: "text", text: "step 2... done!" }] });
				return { content: [{ type: "text", text: "completed" }] };
			},
		};

		const durableTool = adaptExtensionTool(streamingToolDef, () => {
			throw new Error("No nested executeTool");
		});

		// Case 1: api.output is present
		const outputChunks: string[] = [];
		const resultWithOutput = await durableTool.execute(
			{} as any,
			{
				callId: "call_stream_1",
				output: (text: string) => outputChunks.push(text),
			} as any,
			{} as any,
		);

		assert.deepEqual(outputChunks, ["step 1... ", "step 2... done!"]);
		assert.deepEqual(resultWithOutput.output, [{ type: "text", text: "completed" }]);

		// Case 2: api.output is absent
		const resultWithoutOutput = await durableTool.execute(
			{} as any,
			{
				callId: "call_stream_2",
			} as any,
			{} as any,
		);

		assert.deepEqual(resultWithoutOutput.output, [{ type: "text", text: "completed" }]);
	});
});
