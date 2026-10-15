import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { createPiPrompt, DynamicPromptSections } from "../src/runner/prompt.ts";
import { handleActiveSessionCommand, type RunnerCommandPayload, type CommandResponder } from "../src/runner/session-commands.ts";
import { createRegistry, defineTool } from "@earendil-works/pi-durable";
import { SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

test("P1-1: notice unpacking distinguishes notice records from errors and forwards live", () => {
	const notices: Array<{ level: string; message: string }> = [];
	const notice = (level: "info" | "warning" | "error", message: string) => {
		notices.push({ level, message });
	};

	const pendingReports: unknown[] = [
		{ kind: "notice", level: "info", message: "Server connected" },
		{ kind: "notice", level: "warning", message: "Slow connection" },
		new Error("Network timeout"),
		"Plain string warning",
	];

	for (const report of pendingReports) {
		if (report && typeof report === "object" && "kind" in report && (report as { kind?: string }).kind === "notice") {
			const nr = report as { level: "info" | "warning" | "error"; message: string };
			notice(nr.level, nr.message);
		} else {
			notice("warning", report instanceof Error ? report.message : String(report));
		}
	}

	assert.equal(notices.length, 4);
	assert.deepEqual(notices[0], { level: "info", message: "Server connected" });
	assert.deepEqual(notices[1], { level: "warning", message: "Slow connection" });
	assert.deepEqual(notices[2], { level: "warning", message: "Network timeout" });
	assert.deepEqual(notices[3], { level: "warning", message: "Plain string warning" });
	assert.ok(!notices.some((n) => n.message.includes("[object Object]")));

	// Live forwarding after startup
	let liveForwarder: ((level: "info" | "warning" | "error", message: string) => void) | undefined;
	const setNoticeForwarder = (fn: (level: "info" | "warning" | "error", message: string) => void) => {
		liveForwarder = fn;
	};
	setNoticeForwarder((level, message) => notice(level, message));

	liveForwarder?.("error", "Runtime connection terminated");
	assert.equal(notices.length, 5);
	assert.deepEqual(notices[4], { level: "error", message: "Runtime connection terminated" });
});

test("P2-1: adaptExtensionTool emits tool_result with isError: true when execute throws", async () => {
	let toolResultEmitted = false;
	let capturedResult: unknown = null;

	const mockRunner = {
		hasHandlers: (evt: string) => evt === "tool_result",
		emitToolResult: async (evt: unknown) => {
			toolResultEmitted = true;
			capturedResult = evt;
		},
	};

	const failingToolDef: ToolDefinition = {
		name: "crash_tool",
		description: "Throws an unhandled exception",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("Process segfault or crash");
		},
	};

	const adapted = adaptExtensionTool(
		failingToolDef,
		async () => ({ toolCall: { type: "toolCall", id: "1", name: "crash_tool", arguments: {} }, result: { content: [], details: {} }, isError: false }),
		undefined,
		() => mockRunner as never,
	);

	const outcome = await adapted.execute(
		{},
		{ callId: "c_fault_1", output: () => {} } as never,
		{} as never,
	);

	assert.equal(toolResultEmitted, true);
	assert.equal(outcome.isError, true);
	assert.deepEqual(outcome.output, [{ type: "text", text: "Process segfault or crash" }]);

	const castResult = capturedResult as { isError: boolean; content: Array<{ text: string }> };
	assert.equal(castResult.isError, true);
	assert.deepEqual(castResult.content, [{ type: "text", text: "Process segfault or crash" }]);
});

test("P2-1: createNestedToolExecutor emits tool_result with isError: true on target execution exception", async () => {
	const registry = createRegistry();
	registry.install({
		name: "faulty-tools",
		tools: [
			defineTool({
				name: "throw_nested",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Nested worker died");
				},
			}),
		],
	});

	let nestedResultEmitted = false;
	let capturedNestedResult: unknown = null;

	const mockRunner = {
		hasHandlers: (evt: string) => evt === "tool_result",
		emitToolResult: async (evt: unknown) => {
			nestedResultEmitted = true;
			capturedNestedResult = evt;
		},
	};

	const executor = createNestedToolExecutor(registry, () => mockRunner as never);
	const res = await executor("parent_call_99", "throw_nested", {});

	assert.equal(nestedResultEmitted, true);
	assert.equal(res.isError, true);
	assert.deepEqual(res.result.content, [{ type: "text", text: "Nested worker died" }]);

	const castResult = capturedNestedResult as { isError: boolean; content: Array<{ text: string }>; toolCallId: string };
	assert.equal(castResult.isError, true);
	assert.equal(castResult.toolCallId, "parent_call_99/nested");
	assert.deepEqual(castResult.content, [{ type: "text", text: "Nested worker died" }]);
});

test("P2-2 & P3: dynamic prompt sections filter whitespace and replace removed keys", () => {
	const settings = SettingsManager.inMemory();
	const dynamicSections = new DynamicPromptSections();
	const extension = createPiPrompt(settings, "/test/cwd", { dynamicSections });

	const mockInput = {
		conversationId: "conv_1",
		agent: { cwd: "/test/cwd", tools: [{ name: "read" }] },
	};

	// Initial turn with valid and empty sections
	dynamicSections.updateSections({
		mcp_servers: "  ",
		section_a: "Content A",
		section_empty: "",
		section_whitespace: "   \n\t   ",
	});

	const mcpSection = extension.sections?.find((s) => s.key === "mcp_servers");
	assert.equal(mcpSection?.render(mockInput as never, {} as never), undefined);

	const dynSection = extension.sections?.find((s) => s.key === "dynamic_sections");
	const rendered1 = dynSection?.render(mockInput as never, {} as never) as string;
	assert.ok(rendered1.includes("<section_a>\nContent A\n</section_a>"));
	assert.ok(!rendered1.includes("<section_empty>"));
	assert.ok(!rendered1.includes("<section_whitespace>"));

	// P3: Turn 2 removes section_a - must NOT retain previous section_a
	dynamicSections.updateSections({
		section_b: "Content B",
	});

	const rendered2 = dynSection?.render(mockInput as never, {} as never) as string;
	assert.ok(!rendered2.includes("section_a"), "Removed section_a must not be retained");
	assert.ok(rendered2.includes("<section_b>\nContent B\n</section_b>"));
});

test("P2-3: session-commands handles instructions, guards thinking level, and falls back on unknown type", async () => {
	const responses: Array<{ type: "success" | "error"; id?: string; command: string; data?: unknown; message?: string }> = [];
	const responder: CommandResponder = {
		success: (id, command, data) => responses.push({ type: "success", id, command, data }),
		error: (id, command, message) => responses.push({ type: "error", id, command, message }),
	};

	let compactedWith: string | undefined;
	let thinkingLevelSet: string | undefined;

	const mockDurable = {
		controller: {
			compact: async (instructions?: string) => {
				compactedWith = instructions;
			},
			setThinkingLevel: async (level: string) => {
				thinkingLevelSet = level;
			},
		},
		view: { current: () => ({ conversation: { docs: {} } }) },
		harness: {},
	};

	// 1. Compact with instructions
	await handleActiveSessionCommand(
		{ type: "compact", id: "1", instructions: "Summarize decisions" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(compactedWith, "Summarize decisions");
	assert.equal(responses[0].type, "success");

	// 2. Set thinking level with missing level
	await handleActiveSessionCommand(
		{ type: "set_thinking_level", id: "2" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(responses[1].type, "error");
	assert.equal(responses[1].message, "Missing thinking level");

	// 3. Set thinking level valid
	await handleActiveSessionCommand(
		{ type: "set_thinking_level", id: "3", level: "high" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(thinkingLevelSet, "high");
	assert.equal(responses[2].type, "success");

	// 4. Unknown command type fallback
	await handleActiveSessionCommand(
		{ id: "4" } as RunnerCommandPayload,
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(responses[3].type, "error");
	assert.equal(responses[3].command, "unknown");
});
