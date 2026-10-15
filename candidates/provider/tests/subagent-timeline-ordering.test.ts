import { test } from "node:test";
import assert from "node:assert/strict";
import { translateToolStart, translateToolUpdate, buildToolItemShape } from "../src/host/tool-delta-translator.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

test("Subagent delegation item carries task in label and summary", () => {
	const task = "Search for authentication bugs across repository";
	const event = {
		type: "tool_execution_start",
		toolCallId: "call_sub_1",
		toolName: "subagent",
		args: { task },
	} as any;

	const { shape, delta } = translateToolStart(event, "/tmp");

	assert.equal(shape.type, "delegation");
	assert.equal(shape.label, task);
	assert.equal(shape.summary, task);
	assert.equal(delta.item?.type, "delegation");
	assert.equal(delta.item?.label, task);
	assert.equal(delta.item?.summary, task);
});

test("BBChildEventAdapter does NOT duplicate user task prompt into card stream", () => {
	const wireEvents: BBWireEvent[] = [];
	const adapter = new BBChildEventAdapter((ev) => wireEvents.push(ev), "call_sub_1");

	// Initial prompt submitted to child conversation
	const inputEvent: AgentEvent = {
		type: "message_start",
		message: {
			role: "user",
			content: [{ type: "text", text: "Search for authentication bugs across repository" }],
		},
	} as any;

	adapter.handleEvent(inputEvent);

	// User prompt is already rendered in item.open summary and must NOT be re-emitted as an assistant text delta
	assert.equal(wireEvents.length, 0, "User prompt must not be duplicated into assistant message stream");
});

test("Child tool execution deltas strictly carry parentRef and parentToolCallId matching delegation callId", () => {
	const translator = new DeltaTranslator();
	const childToolStart: any = {
		type: "tool_execution_start",
		toolCallId: "call_sub_1:call_bash_1",
		toolName: "bash",
		args: { command: "ls -la" },
		parentRef: "call_sub_1",
	};

	const deltas = translator.translate(childToolStart, {
		providerOptions: {},
		lastCheckpointId: null,
		fallbackCwd: "/tmp",
	});

	assert.equal(deltas.length, 1);
	const delta = deltas[0];
	assert.equal(delta.kind, "item.open");
	assert.equal(delta.key.parentRef, "call_sub_1");
	assert.equal(delta.item?.parentToolCallId, "call_sub_1");
});
