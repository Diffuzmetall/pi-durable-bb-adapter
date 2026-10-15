import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

test("buildToolItemShape maps 'subagent' tool to BB compliant delegation shape", () => {
	// Standard short task
	const shortShape = buildToolItemShape(
		"subagent",
		{ task: "Investigate database performance" },
		"/Users/vanya",
	);
	assert.equal(shortShape.type, "delegation");
	assert.equal(shortShape.childRef, "subagent");
	assert.equal(shortShape.label, "Investigate database performance");
	assert.equal(shortShape.background, true);
	assert.equal(shortShape.summary, "Investigate database performance");

	// Long task (> 80 characters) truncation for label, full for summary
	const longTask = "A".repeat(95);
	const longShape = buildToolItemShape(
		"subagent",
		{ task: longTask },
		"/Users/vanya",
	);
	assert.equal(longShape.type, "delegation");
	assert.equal(longShape.label.length, 80);
	assert.ok(longShape.label.endsWith("..."));
	assert.equal(longShape.label, `${"A".repeat(77)}...`);
	assert.equal(longShape.summary, longTask);

	// Missing / empty task fallback
	const emptyShape = buildToolItemShape("subagent", {}, "/Users/vanya");
	assert.equal(emptyShape.type, "delegation");
	assert.equal(emptyShape.label, "Subagent delegation");
	assert.equal(emptyShape.childRef, "subagent");
	assert.equal(emptyShape.background, true);
	assert.equal(emptyShape.summary, undefined);

	// Explicit conversationId in args
	const customConvShape = buildToolItemShape(
		"subagent",
		{ task: "Subtask", conversationId: "conv-sub-1" },
		"/Users/vanya",
	);
	assert.equal(customConvShape.childRef, "conv-sub-1");

	// Explicit childRef fallback in args
	const customChildRefShape = buildToolItemShape(
		"subagent",
		{ task: "Subtask", childRef: "child-ref-2" },
		"/Users/vanya",
	);
	assert.equal(customChildRefShape.childRef, "child-ref-2");
});

test("buildToolItemShape maps 'agent_spawn' tool to BB compliant delegation shape", () => {
	const spawnShape = buildToolItemShape(
		"agent_spawn",
		{ name: "reviewer", task: "Review architecture rules" },
		"/Users/vanya",
	);
	assert.equal(spawnShape.type, "delegation");
	assert.equal(spawnShape.childRef, "reviewer");
	assert.equal(spawnShape.label, "Review architecture rules");
	assert.equal(spawnShape.summary, "Review architecture rules");

	const spawnDefault = buildToolItemShape("agent_spawn", {}, "/Users/vanya");
	assert.equal(spawnDefault.type, "delegation");
	assert.equal(spawnDefault.childRef, "agent");
	assert.equal(spawnDefault.label, "Agent delegation");
});

test("buildToolItemShape maps 'agent_spawn_graph' tool to BB compliant delegation shape", () => {
	const graphShape = buildToolItemShape(
		"agent_spawn_graph",
		{
			name: "audit-pipeline",
			agents: [
				{ name: "scanner", task: "Scan vulnerabilities" },
				{ name: "reporter", task: "Generate report" },
			],
		},
		"/Users/vanya",
	);
	assert.equal(graphShape.type, "delegation");
	assert.equal(graphShape.childRef, "audit-pipeline");
	assert.ok(graphShape.label.includes("audit-pipeline") || graphShape.label.includes("Graph"));
});

test("translateToolStart emits item.open with delegation shape and Bot icon presentation", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_start_1",
			toolName: "subagent",
			args: { task: "Run lint and review code changes" },
		},
		"/Users/vanya",
	);

	assert.equal(start.delta.kind, "item.open");
	assert.deepEqual(start.delta.key, { providerItemId: "call_sub_start_1" });
	assert.equal(start.shape.type, "delegation");
	assert.equal(start.shape.label, "Run lint and review code changes");
	assert.equal(start.shape.childRef, "subagent");
	assert.equal(start.shape.background, true);

	const presentation = start.delta.presentation as Record<string, unknown>;
	assert.ok(presentation, "presentation must be present for delegation item.open");
	assert.deepEqual(presentation.icon, { glyph: "Bot" });
	assert.deepEqual(presentation.label, {
		pending: "Running subagent",
		completed: "Subagent completed",
	});
	assert.equal(presentation.title, "Run lint and review code changes");

	// Wire contract validation
	const parseResult = threadDeltaSchema.safeParse(start.delta);
	assert.equal(parseResult.success, true, "item.open delta must conform to threadDeltaSchema");
});

test("translateToolEnd updates childRef from event.details.conversationId and completes delegation", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_end_1",
			toolName: "subagent",
			args: { task: "Perform architectural review" },
		},
		"/Users/vanya",
	);

	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_end_1",
			toolName: "subagent",
			result: "Architectural review finished: 0 findings.",
			isError: false,
			details: { conversationId: "conv-resolved-42" },
		},
		start.shape,
		"/Users/vanya",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "completed");
	assert.equal(endDelta.exitCode, 0);
	assert.equal(endDelta.error, undefined);
	assert.equal(endDelta.resultText, "Architectural review finished: 0 findings.");

	const item = endDelta.item as Record<string, unknown>;
	assert.equal(item.type, "delegation");
	assert.equal(item.childRef, "conv-resolved-42");
	assert.equal(item.label, "Perform architectural review");
	assert.equal(item.summary, "Architectural review finished: 0 findings.");
	assert.equal(item.background, true);

	const presentation = endDelta.presentation as Record<string, unknown>;
	assert.ok(presentation, "presentation must be preserved on item.close for delegation");
	assert.deepEqual(presentation.icon, { glyph: "Bot" });
	assert.deepEqual(presentation.label, {
		pending: "Running subagent",
		completed: "Subagent completed",
	});

	// Truncation check for result text > 300 characters
	const longResult = "Summary: " + "X".repeat(350);
	const longEndDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_end_long",
			toolName: "subagent",
			result: longResult,
			isError: false,
			details: { conversationId: "conv-long-99" },
		},
		start.shape,
		"/Users/vanya",
	);
	const longItem = longEndDelta.item as Record<string, unknown>;
	assert.ok(typeof longItem.summary === "string");
	assert.equal((longItem.summary as string).length, 300);
	assert.ok((longItem.summary as string).endsWith("..."));

	// Wire contract validation
	const parseResult = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parseResult.success, true, "completed delegation delta must conform to threadDeltaSchema");
	const parseLongResult = threadDeltaSchema.safeParse(longEndDelta);
	assert.equal(parseLongResult.success, true, "long summary delegation delta must conform to threadDeltaSchema");
});

test("translateToolEnd handles subagent execution failure", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_err_1",
			toolName: "subagent",
			args: { task: "Generate complex schema" },
		},
		"/Users/vanya",
	);

	const errorEndDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_err_1",
			toolName: "subagent",
			result: "Subagent execution timed out after 60s",
			isError: true,
			details: { conversationId: "conv-failed-1" },
		},
		start.shape,
		"/Users/vanya",
	);

	assert.equal(errorEndDelta.kind, "item.close");
	assert.equal(errorEndDelta.status, "failed");
	assert.equal(errorEndDelta.exitCode, 1);
	assert.deepEqual(errorEndDelta.error, { message: "Subagent execution timed out after 60s" });

	const item = errorEndDelta.item as Record<string, unknown>;
	assert.equal(item.type, "delegation");
	assert.equal(item.childRef, "conv-failed-1");
	assert.equal(item.summary, "Subagent execution timed out after 60s");

	const presentation = errorEndDelta.presentation as Record<string, unknown>;
	assert.deepEqual(presentation.icon, { glyph: "Bot" });

	const parseResult = threadDeltaSchema.safeParse(errorEndDelta);
	assert.equal(parseResult.success, true, "failed delegation delta must conform to threadDeltaSchema");
});

test("preserves existing tool contracts for bash, write, and edit", () => {
	// 1. bash command
	const bashStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_bash",
			toolName: "bash",
			args: { command: "git status" },
		},
		"/Users/vanya",
	);
	assert.equal(bashStart.shape.type, "command");
	assert.equal(bashStart.delta.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(bashStart.delta).success, true);

	const bashEnd = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash",
			toolName: "bash",
			result: "On branch main",
			isError: false,
		},
		bashStart.shape,
		"/Users/vanya",
	);
	assert.equal(bashEnd.status, "completed");
	assert.equal(bashEnd.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(bashEnd).success, true);

	// 2. write fileChange
	const writeStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_write",
			toolName: "write",
			args: { path: "/file.txt", content: "data" },
		},
		"/Users/vanya",
	);
	assert.equal(writeStart.shape.type, "fileChange");
	assert.equal(writeStart.delta.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(writeStart.delta).success, true);

	// 3. edit fileChange
	const editStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_edit",
			toolName: "edit",
			args: { path: "/file.txt", edits: [{ oldText: "a", newText: "b" }] },
		},
		"/Users/vanya",
	);
	assert.equal(editStart.shape.type, "fileChange");
	assert.equal(threadDeltaSchema.safeParse(editStart.delta).success, true);
});
