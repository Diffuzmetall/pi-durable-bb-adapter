import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import {
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent, BBToolExecutionEndEvent, BBToolExecutionUpdateEvent } from "../src/runner/bridge/contracts.ts";

test("BBEventAdapter: tool_execution_end with event.entry === undefined emits isError: true with fault result (D-5)", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_fault_1",
			toolName: "bash",
			entry: undefined,
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.equal(endEvt.type, "tool_execution_end");
	assert.equal(endEvt.toolCallId, "call_fault_1");
	assert.equal(endEvt.toolName, "bash");
	assert.equal(endEvt.isError, true);
	assert.equal(
		endEvt.result,
		"Tool execution faulted or was orphaned without generating an entry record.",
	);
});

test("BBEventAdapter: tool_execution_end with valid entry and isError: false emits clean result", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_read_1",
			toolName: "read",
			entry: {
				model: [
					{
						role: "toolResult",
						toolCallId: "call_read_1",
						toolName: "read",
						content: [{ type: "text", text: "file content lines" }],
						isError: false,
					},
				],
			} as any,
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.equal(endEvt.type, "tool_execution_end");
	assert.equal(endEvt.toolCallId, "call_read_1");
	assert.equal(endEvt.result, "file content lines");
	assert.equal(endEvt.isError, false);
});

test("BBEventAdapter: tool_execution_end with explicit error preserves isError: true", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_err_1",
			toolName: "bash",
			entry: {
				model: [
					{
						role: "toolResult",
						toolCallId: "call_err_1",
						toolName: "bash",
						content: "command failed with code 1",
						isError: true,
					},
				],
			} as any,
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.equal(endEvt.type, "tool_execution_end");
	assert.equal(endEvt.result, "command failed with code 1");
	assert.equal(endEvt.isError, true);
});

test("BBEventAdapter: tool_execution_update forwards trimStart when present (D-9)", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	adapter.handleEvent(
		{
			type: "tool_execution_update",
			toolCallId: "call_stream_1",
			toolName: "bash",
			output: {
				trimStart: 256,
				append: "tail chunk\n",
			},
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const updateEvt = emitted[0] as BBToolExecutionUpdateEvent;
	assert.equal(updateEvt.type, "tool_execution_update");
	assert.equal(updateEvt.toolCallId, "call_stream_1");
	assert.equal(updateEvt.toolName, "bash");
	assert.equal(updateEvt.partialResult, "tail chunk\n");
	assert.equal(updateEvt.trimStart, 256);
});

test("BBEventAdapter: tool_execution_end forwards details metadata from event or entry (D-6)", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	const diffDetails = { diff: "@@ -1 +1 @@\n-a\n+b\n", patch: "patch string" };

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_edit_1",
			toolName: "edit",
			entry: {
				model: [
					{
						role: "toolResult",
						content: "applied patch",
						isError: false,
					},
				],
				data: diffDetails,
			} as any,
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.deepEqual(endEvt.details, diffDetails);
});

test("tool-delta-translator: maps faulted tool end to failed item status with error message (D-5)", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_bash_fault",
			toolName: "bash",
			args: { command: "curl -fail http://internal/service" },
		},
		"/workspace",
	);

	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash_fault",
			toolName: "bash",
			result: "Tool execution faulted or was orphaned without generating an entry record.",
			isError: true,
		},
		start.shape,
		"/workspace",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "failed");
	assert.equal(endDelta.exitCode, 1);
	assert.equal(
		endDelta.resultText,
		"Tool execution faulted or was orphaned without generating an entry record.",
	);
	assert.deepEqual(endDelta.error, {
		message: "Tool execution faulted or was orphaned without generating an entry record.",
	});

	// Conforms to @bb/provider-bridge-protocol threadDeltaSchema
	const parsed = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parsed.success, true);
});

test("tool-delta-translator: enriches fileChange item with diff metadata and validates with threadDeltaSchema (D-6)", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_edit_diff",
			toolName: "edit",
			args: {
				path: "/workspace/src/app.ts",
				edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
			},
		},
		"/workspace",
	);

	const diffText = "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_edit_diff",
			toolName: "edit",
			result: "Successfully modified /workspace/src/app.ts",
			isError: false,
			details: { diff: diffText },
		},
		start.shape,
		"/workspace",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "completed");
	assert.equal(endDelta.exitCode, 0);

	const item = endDelta.item as { type: string; changes: Array<{ path: string; kind: string; diff?: string }> };
	assert.equal(item.type, "fileChange");
	assert.equal(item.changes.length, 1);
	assert.equal(item.changes[0].diff, diffText);

	// Conforms to @bb/provider-bridge-protocol threadDeltaSchema
	const parsed = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parsed.success, true);
});
