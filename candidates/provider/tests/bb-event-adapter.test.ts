import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

test("BBEventAdapter handles native AgentEvent stream correctly", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	// 1. Run & turn start
	adapter.handleEvent({ type: "run_start", inputs: [] as any }, dummyView);
	adapter.handleEvent({ type: "turn_start" }, dummyView);

	assert.equal(emitted.some((e) => e.type === "agent_start"), true);
	assert.equal(emitted.some((e) => e.type === "turn_start"), true);

	// 2. Tool 1 starts
	adapter.handleEvent(
		{
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "echo tool1" },
		},
		dummyView,
	);

	assert.equal(
		emitted.some(
			(e) =>
				e.type === "tool_execution_start" &&
				e.toolCallId === "call_1" &&
				(e.args as any)?.command === "echo tool1",
		),
		true,
	);

	// 3. Tool 1 ends
	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			entry: {
				model: [
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "tool1 output\n" }],
						isError: false,
					},
				],
			} as any,
		},
		dummyView,
	);

	assert.equal(
		emitted.some(
			(e) =>
				e.type === "tool_execution_end" &&
				e.toolCallId === "call_1" &&
				e.result === "tool1 output\n" &&
				e.isError === false,
		),
		true,
	);

	// 4. Compaction events
	adapter.handleEvent(
		{
			type: "compaction_start",
			taskId: 10 as any,
			reason: "manual",
			blocking: false,
		},
		dummyView,
	);
	adapter.handleEvent(
		{
			type: "compaction_end",
			taskId: 10 as any,
			reason: "manual",
		},
		dummyView,
	);

	const compStart = emitted.find((e) => e.type === "compaction_start");
	const compEnd = emitted.find((e) => e.type === "compaction_end");
	assert.ok(compStart);
	assert.ok(compEnd);
	assert.equal((compStart as any).reason, "manual");
});

test("DeltaTranslator translates compaction and context window deltas", () => {
	const translator = new DeltaTranslator();
	const ctx = { threadId: "thr_test" };

	// 1. Compaction start
	const deltasStart = translator.translate({ type: "compaction_start", reason: "manual" }, ctx);
	assert.equal(deltasStart.length, 2);
	assert.equal(deltasStart[0].kind, "turn.open");
	assert.equal(deltasStart[1].kind, "item.open");
	assert.equal(deltasStart[1].item.type, "compaction");

	// 2. Compaction end
	const deltasEnd = translator.translate({ type: "compaction_end", reason: "manual" }, ctx);
	assert.equal(deltasEnd.some((d) => d.kind === "context.compacted"), true);
	assert.equal(deltasEnd.some((d) => d.kind === "turn.boundary"), true);

	// 3. Context window usage
	const deltasContext = translator.translate(
		{ type: "context_window", usedTokens: 4500, contextWindow: 200000 },
		ctx,
	);
	assert.equal(deltasContext.length, 1);
	assert.equal(deltasContext[0].kind, "contextWindow");
	assert.equal(deltasContext[0].used, 4500);
	assert.equal(deltasContext[0].size, 200000);
	assert.equal(deltasContext[0].estimated, true);
});

test("BBEventAdapter emits thinking_end when transitioning from thinking_delta to text_delta", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	adapter.handleEvent(
		{
			type: "message_update",
			changes: [{ type: "thinking_delta", delta: "Thinking deeply..." }],
		} as any,
		dummyView,
	);

	assert.equal(emitted.length, 1);
	assert.deepEqual(emitted[0], {
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Thinking deeply...",
		},
	});

	adapter.handleEvent(
		{
			type: "message_update",
			changes: [{ type: "text_delta", delta: "Hello user!" }],
		} as any,
		dummyView,
	);

	assert.equal(emitted.length, 3);
	assert.deepEqual(emitted[1], {
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: "Thinking deeply...",
		},
	});
	assert.deepEqual(emitted[2], {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "Hello user!",
		},
	});
});

test("BBEventAdapter emits thinking_end on message_end and tool_execution_start", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	// 1. Thinking before tool execution
	adapter.handleEvent(
		{
			type: "message_update",
			changes: [{ type: "thinking_delta", delta: "Thinking about bash command..." }],
		} as any,
		dummyView,
	);

	adapter.handleEvent(
		{
			type: "tool_execution_start",
			toolCallId: "call_t1",
			toolName: "bash",
			args: { command: "ls" },
		},
		dummyView,
	);

	const thinkingEnd1 = emitted.find(
		(e) =>
			e.type === "message_update" &&
			(e as any).assistantMessageEvent?.type === "thinking_end",
	);
	assert.ok(thinkingEnd1);
	assert.equal((thinkingEnd1 as any).assistantMessageEvent.content, "Thinking about bash command...");

	// 2. Thinking before message_end
	emitted.length = 0;
	adapter.handleEvent(
		{
			type: "message_update",
			changes: [{ type: "thinking_delta", delta: "Final reasoning..." }],
		} as any,
		dummyView,
	);

	adapter.handleEvent(
		{
			type: "message_end",
			entry: {
				model: [{ role: "assistant", content: [] }],
			} as any,
		},
		dummyView,
	);

	const thinkingEnd2 = emitted.find(
		(e) =>
			e.type === "message_update" &&
			(e as any).assistantMessageEvent?.type === "thinking_end",
	);
	assert.ok(thinkingEnd2);
	assert.equal((thinkingEnd2 as any).assistantMessageEvent.content, "Thinking about bash command...Final reasoning...");
});
