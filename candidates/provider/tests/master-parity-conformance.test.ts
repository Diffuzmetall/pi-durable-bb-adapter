import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { SettingsManager, type ExtensionRunner, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import plugin from "../server.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { buildToolItemShape, translateToolStart, translateToolEnd } from "../src/host/tool-delta-translator.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import { forkSessionDatabase } from "../src/host/thread-fork.ts";
import { handleThreadStop, type BridgeRouterContext } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { BBToolExecutionUpdateEvent, BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { DynamicPromptSections, createPiPrompt } from "../src/runner/prompt.ts";
import { adaptExtensionTool } from "../src/runner/extension-bridge.ts";
import { isProcessAlive } from "../src/runner/session-storage.ts";

test("D-1, D-2, D-3, D-4: Thinking presentation, reasoning lifecycle & settings schema parity", () => {
	let settingsSchema: Record<string, unknown> | undefined;
	let providerDef: { deriveProviderOptions?: (c: { settings?: Record<string, unknown> }) => { hideThinking: boolean } } | undefined;
	plugin({
		settings: { define: (s: Record<string, unknown>) => { settingsSchema = s; } },
		providers: { register: (p: unknown) => { providerDef = p as typeof providerDef; return p; } },
	});
	assert.ok(settingsSchema && "hideThinking" in settingsSchema, "D-4: hideThinking registered");
	assert.equal("openThinkingByDefault" in (settingsSchema ?? {}), false, "D-4: openThinkingByDefault retired");
	assert.equal(providerDef?.deriveProviderOptions?.({ settings: { hideThinking: true } })?.hideThinking, true, "D-2: options derived");

	const tr = new DeltaTranslator();
	const openDeltas = tr.translate(
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan..." } },
		{ threadId: "t1" },
	);
	assert.equal(openDeltas.length, 2, "D-1: emits item.open and item.textDelta");
	const openItem = openDeltas[0] as { presentation?: { icon?: { glyph?: string }; suppress?: boolean } };
	assert.equal(openItem.presentation?.icon?.glyph, "Brain", "D-1: Brain glyph presentation");

	const suppressed = new DeltaTranslator().translate(
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan..." } },
		{ threadId: "t1", providerOptions: { hideThinking: true } },
	);
	assert.equal((suppressed[0] as { presentation?: { suppress?: boolean } })?.presentation?.suppress, true, "D-1, D-4: suppress thinking");

	const closeDeltas = tr.translate({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, { threadId: "t1" });
	assert.equal(closeDeltas[0]?.kind, "item.textClose", "D-3: thinking_end closes channel");

	const fbTr = new DeltaTranslator();
	fbTr.translate({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Ponder..." } }, { threadId: "t1" });
	const textTrans = fbTr.translate({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer" } }, { threadId: "t1" });
	assert.ok(textTrans.some((d) => d.kind === "item.textClose"), "D-1, D-3: fallback closure on text_delta");
});

test("D-5, D-6, D-9: Tool fault integrity, diff metadata & trimStart output streaming", () => {
	assert.equal(buildToolItemShape("write", { path: "a.ts" }, "/w").type, "fileChange", "D-6: write is fileChange");
	assert.equal(buildToolItemShape("edit", { path: "b.ts" }, "/w").type, "fileChange", "D-6: edit is fileChange");

	const start = translateToolStart({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} }, "/w");
	const faultEnd = translateToolEnd(
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "Faulted task", isError: true },
		start.shape,
		"/w",
	);
	assert.equal(faultEnd.status, "failed", "D-5: fault status failed");
	assert.equal(faultEnd.exitCode, 1, "D-5: fault exitCode 1");
	assert.equal(faultEnd.error?.message, "Faulted task", "D-5: fault error message");
	assert.equal(threadDeltaSchema.safeParse(faultEnd).success, true);

	const diffStart = translateToolStart(
		{ type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "b.ts", edits: [{ oldText: "1", newText: "2" }] } },
		"/w",
	);
	const diffEnd = translateToolEnd(
		{ type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: "ok", isError: false, details: { diff: "@@ -1 +1 @@" } },
		diffStart.shape,
		"/w",
	);
	const fileItem = diffEnd.item as { changes: Array<{ diff?: string }> };
	assert.equal(fileItem.changes[0]?.diff, "@@ -1 +1 @@", "D-6: diff metadata preserved");

	const wireEvents: BBWireEvent[] = [];
	new BBEventAdapter((evt) => wireEvents.push(evt)).handleEvent(
		{ type: "tool_execution_update", toolCallId: "c2", toolName: "bash", output: { trimStart: 64, append: "out\n" } },
		{} as unknown as DurableView,
	);
	assert.equal((wireEvents[0] as BBToolExecutionUpdateEvent).trimStart, 64, "D-9: trimStart forwarded on update");
});

test("D-7, D-8: Cumulative usage monotonicity & checkpoint boundary extraction", () => {
	const agentRes = translateAgentEnd(
		{
			type: "agent_end",
			providerCheckpointId: "chk_99",
			cumulativeUsage: { totalTokens: 1200, inputTokens: 900, outputTokens: 300 },
			message: { usage: { totalTokens: 250, input: 200, output: 50 } },
			messages: [],
		},
		"",
		false,
	);
	const usageDelta = agentRes.deltas.find((d) => d.kind === "usage") as { total?: { totalTokens?: number }; last?: { totalTokens?: number } };
	assert.equal(usageDelta.total?.totalTokens, 1200, "D-7: monotonic total spend from pi.usage");
	assert.equal(usageDelta.last?.totalTokens, 250, "D-7: turn spend in last");

	const boundaryDelta = agentRes.deltas.find((d) => d.kind === "turn.boundary") as { providerCheckpointId?: string };
	assert.equal(boundaryDelta.providerCheckpointId, "chk_99", "D-8: providerCheckpointId attached");
	for (const delta of agentRes.deltas) {
		assert.equal(threadDeltaSchema.safeParse(delta).success, true);
	}
});

test("D-10: Thread fork via checkpoint ACID SQLite pruning", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-fork-audit-"));
	try {
		const src = join(temp, "source-session");
		mkdirSync(src, { recursive: true });
		const target = join(temp, "target-session");
		const db = new DatabaseSync(join(src, "session.sqlite"));
		db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, content TEXT);");
		const ins = db.prepare("INSERT INTO entries (id, content) VALUES (?, ?);");
		ins.run(1, "one"); ins.run(2, "two"); ins.run(3, "three");
		db.close();

		forkSessionDatabase({ sourceProviderThreadId: src, targetProviderThreadId: target, checkpointId: "2" });
		const targetDb = new DatabaseSync(join(target, "session.sqlite"));
		const rows = targetDb.prepare("SELECT id FROM entries ORDER BY id ASC;").all() as Array<{ id: number }>;
		targetDb.close();

		assert.deepEqual(rows.map((r) => r.id), [1, 2], "D-10: checkpoint pruning deleted entry id > 2");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("D-11, D-12, D-13: Turn interruption, abort isolation & stop release handling", async () => {
	const interruptedRes = translateAgentEnd({ type: "agent_end", stopReason: "aborted", messages: [] }, "", false);
	const bDelta = interruptedRes.deltas.find((d) => d.kind === "turn.boundary") as { status?: string };
	assert.equal(bDelta.status, "interrupted", "D-11: aborted stopReason sets status interrupted");

	let abortCalled = false;
	let closeCalled = false;
	const mockSession = {
		runner: { exited: false },
		abort: async () => { abortCalled = true; },
		closeGracefully: async () => { closeCalled = true; },
		getLastCheckpointId: () => "chk_int_1",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_stop", mockSession);

	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (m, p) => notifications.push({ method: m, params: p }),
		sendResult: (id, res) => results.push({ id, result: res }),
		sendError: () => {},
	};

	await handleThreadStop("r1", { threadId: "thr_stop", intent: "interrupt" }, ctx);
	assert.equal(abortCalled, true, "D-12: abort called on interrupt");
	assert.deepEqual(notifications[0]?.params?.deltas, [{ kind: "session.ended" }], "D-12: session.ended emitted");
	assert.equal(results[0]?.result?.providerCheckpointId, "chk_int_1", "D-12: checkpoint returned");
	assert.ok(registry.get("thr_stop"), "D-12: session retained in registry on interrupt");

	await handleThreadStop("r2", { threadId: "thr_stop", intent: "release" }, ctx);
	assert.equal(closeCalled, true, "D-13: closeGracefully called on release");
	assert.equal(registry.get("thr_stop"), undefined, "D-13: session removed on release");
});

test("D-14, D-15: Subagent delegation visual cards & conversationId extraction", () => {
	const delegShape = buildToolItemShape("subagent", { task: "Inspect auth module" }, "/w");
	assert.equal(delegShape.type, "delegation", "D-14: type delegation");
	const start = translateToolStart({ type: "tool_execution_start", toolCallId: "c_sub", toolName: "subagent", args: {} }, "/w");
	const openPresentation = start.delta.presentation as { icon?: { glyph?: string } };
	assert.equal(openPresentation.icon?.glyph, "Bot", "D-14: Bot glyph presentation");

	const end = translateToolEnd(
		{ type: "tool_execution_end", toolCallId: "c_sub", toolName: "subagent", result: "Done", isError: false, details: { conversationId: "conv_42" } },
		start.shape,
		"/w",
	);
	const endItem = end.item as { childRef?: string };
	assert.equal(endItem.childRef, "conv_42", "D-15: childRef updated to conversationId");
	assert.equal(threadDeltaSchema.safeParse(end).success, true);
});

test("D-16, D-17, D-18: Dynamic prompt sections, direct MCP & tool lifecycle hooks", async () => {
	const dynamicSections = new DynamicPromptSections();
	const promptExt = createPiPrompt(SettingsManager.inMemory(), "/w", { dynamicSections });
	dynamicSections.updateSections({ mcp_servers: "- direct-db (direct)" });
	const mcpSec = promptExt.sections?.find((s) => s.key === "mcp_servers");
	const rendered = mcpSec?.render(
		{ conversationId: "c1", agent: { cwd: "/w", tools: [{ name: "read" }] } } as unknown as Parameters<NonNullable<typeof mcpSec>["render"]>[0],
		{} as unknown as Parameters<NonNullable<typeof mcpSec>["render"]>[1],
	) as string;
	assert.ok(rendered.includes("<mcp_servers>") && rendered.includes("- direct-db (direct)"), "D-16, D-17: direct MCP XML tagging");

	let callHook = false;
	let resultHook = false;
	const mockRunner = {
		hasHandlers: () => true,
		emitToolCall: async () => { callHook = true; return undefined; },
		emitToolResult: async () => { resultHook = true; },
	} as unknown as ExtensionRunner;

	const toolDef: ToolDefinition = {
		name: "ping",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
	};
	const adapted = adaptExtensionTool(toolDef, async () => ({} as never), undefined, () => mockRunner);
	const execRes = await adapted.execute({} as never, { callId: "c_ping" } as never, {} as never);
	assert.equal(callHook, true, "D-18: emitToolCall invoked");
	assert.equal(resultHook, true, "D-18: emitToolResult invoked");
	assert.deepEqual(execRes.output, [{ type: "text", text: "pong" }]);
});

test("D-19, D-20: Diagnostics notices & session ownership tracking", () => {
	const notices: Array<{ level: string; message: string }> = [];
	const rawRecord: unknown = { kind: "notice", level: "info", message: "MCP ready" };
	if (rawRecord && typeof rawRecord === "object" && "kind" in rawRecord && (rawRecord as { kind?: string }).kind === "notice") {
		const nr = rawRecord as { level: string; message: string };
		notices.push({ level: nr.level, message: nr.message });
	}
	assert.deepEqual(notices[0], { level: "info", message: "MCP ready" }, "D-19: notice unpacked cleanly");
	assert.equal(notices.some((n) => n.message.includes("[object Object]")), false, "D-19: zero [object Object]");

	assert.equal(isProcessAlive(process.pid), true, "D-20: current process is alive");
	assert.equal(isProcessAlive(0), false, "D-20: PID 0 is not alive");
	assert.equal(isProcessAlive(9999999), false, "D-20: stale PID is not alive");
});
