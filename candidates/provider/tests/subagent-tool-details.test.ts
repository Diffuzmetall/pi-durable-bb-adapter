import test from "node:test";
import assert from "node:assert/strict";
import {
	buildToolExecutionUpdate,
	buildToolExecutionEnd,
} from "../src/runner/bridge/tool-result-extractor.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";

test("buildToolExecutionEnd recovers buffered conversationId from tool_execution_update", () => {
	const toolCallId = "call_subagent_123";

	// 1. Tool execution update provides details with conversationId
	const update = buildToolExecutionUpdate({
		toolCallId,
		toolName: "subagent",
		details: { conversationId: 42, task: "Analyze metrics" },
	});
	assert.ok(update);
	assert.deepEqual(update.details, { conversationId: 42, task: "Analyze metrics" });

	// 2. Tool execution end arrives with NO details and NO entry.data
	const endEvent = buildToolExecutionEnd({
		toolCallId,
		toolName: "subagent",
		entry: {
			kind: "tool_result",
			model: [{ isError: false, content: "Done" }],
		} as any,
	});

	// Details should be recovered from the buffered update!
	assert.ok(endEvent.details, "Details must be recovered from buffered update");
	assert.deepEqual(endEvent.details, { conversationId: 42, task: "Analyze metrics" });
});

test("DeltaTranslator propagates buffered conversationId to delegation item.close childRef", () => {
	const translator = new DeltaTranslator();
	const ctx = { threadId: "thr_parent", cwd: "/test" };

	// 1. Tool start: initial delegation item.open
	const startDeltas = translator.translate({
		type: "tool_execution_start",
		toolCallId: "call_sub_buff_1",
		toolName: "subagent",
		args: { task: "Subagent mission" },
	}, ctx);
	assert.equal(startDeltas.length, 1);
	assert.equal(startDeltas[0].kind, "item.open");

	// 2. Tool update arrives with conversationId in details
	translator.translate({
		type: "tool_execution_update",
		toolCallId: "call_sub_buff_1",
		toolName: "subagent",
		details: { conversationId: 77 },
		partialResult: "Starting work...",
	}, ctx);

	// 3. Tool end arrives without details
	const endDeltas = translator.translate({
		type: "tool_execution_end",
		toolCallId: "call_sub_buff_1",
		toolName: "subagent",
		result: "Task completed successfully",
		isError: false,
	}, ctx);

	assert.equal(endDeltas.length, 1);
	const closeDelta = endDeltas[0];
	assert.equal(closeDelta.kind, "item.close");
	const item = closeDelta.item as Record<string, unknown>;
	assert.equal(item.type, "delegation");
	// childRef must be the recovered conversationId (77), NOT fallback "subagent"!
	assert.equal(item.childRef, "77");
	assert.equal(threadDeltaSchema.safeParse(closeDelta).success, true);
});
