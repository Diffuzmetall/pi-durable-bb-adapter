import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

describe("Native Subagent In-Place Streaming (Cycle 80)", () => {
	it("BBChildEventAdapter decorates child events with parentRef and prefixes toolCallId", () => {
		const emitted: BBWireEvent[] = [];
		const childAdapter = new BBChildEventAdapter((evt) => emitted.push(evt), "parent-call-123");

		// 1. Child thinking delta
		childAdapter.handleEvent({
			type: "message_update",
			changes: [{ type: "thinking_delta", delta: "Subagent is analyzing data..." }],
		} as AgentEvent);

		assert.equal(emitted.length, 1);
		const thinkingEvt = emitted[0];
		assert.equal(thinkingEvt.type, "message_update");
		if (thinkingEvt.type === "message_update") {
			assert.equal(thinkingEvt.parentRef, "parent-call-123");
			assert.equal(thinkingEvt.assistantMessageEvent.type, "thinking_delta");
		}

		// 2. Child tool start
		childAdapter.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "ls -la" },
		} as unknown as AgentEvent);

		assert.equal(emitted.length, 3); // thinking_end + tool_execution_start
		const toolStartEvt = emitted[2];
		assert.equal(toolStartEvt.type, "tool_execution_start");
		if (toolStartEvt.type === "tool_execution_start") {
			assert.equal(toolStartEvt.parentRef, "parent-call-123");
			assert.equal(toolStartEvt.toolCallId, "parent-call-123:bash-1");
			assert.equal(toolStartEvt.toolName, "bash");
		}

		// 3. Child tool update (output progress)
		childAdapter.handleEvent({
			type: "tool_execution_update",
			toolCallId: "bash-1",
			toolName: "bash",
			output: { append: "total 12\n" },
		} as unknown as AgentEvent);

		const toolUpdateEvt = emitted[3];
		assert.equal(toolUpdateEvt.type, "tool_execution_update");
		if (toolUpdateEvt.type === "tool_execution_update") {
			assert.equal(toolUpdateEvt.parentRef, "parent-call-123");
			assert.equal(toolUpdateEvt.toolCallId, "parent-call-123:bash-1");
			assert.equal(toolUpdateEvt.partialResult, "total 12\n");
		}

		// 4. Child tool end
		childAdapter.handleEvent({
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			entry: {
				model: [{ role: "toolResult", content: "total 12\nfile.txt", isError: false }],
			},
		} as unknown as AgentEvent);

		const toolEndEvt = emitted[4];
		assert.equal(toolEndEvt.type, "tool_execution_end");
		if (toolEndEvt.type === "tool_execution_end") {
			assert.equal(toolEndEvt.parentRef, "parent-call-123");
			assert.equal(toolEndEvt.toolCallId, "parent-call-123:bash-1");
			assert.equal(toolEndEvt.isError, false);
		}

		// 5. Lifecycle events: turn_start and turn_end are suppressed so parent turn isn't broken
		childAdapter.handleEvent({ type: "turn_start" } as AgentEvent);
		childAdapter.handleEvent({ type: "turn_end" } as AgentEvent);
		assert.equal(emitted.length, 5); // turn events remain suppressed

		// 6. Child run_end emits agent_end scoped to subagent conversation
		childAdapter.handleEvent({ type: "run_end" } as AgentEvent);
		assert.equal(emitted.length, 6);
		assert.equal(emitted[5].type, "agent_end");
		assert.equal(emitted[5].parentRef, "parent-call-123");
	});

	it("DeltaTranslator emits BB schema-valid thread deltas for child tool and reasoning events", () => {
		const translator = new DeltaTranslator();
		const ctx = { threadId: "thr-test", cwd: "/tmp" };

		// Child reasoning delta
		const reasoningDeltas = translator.translate(
			{
				type: "message_update",
				parentRef: "call-delegation-1",
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting..." },
			},
			ctx,
		);

		assert.ok(reasoningDeltas.length >= 2);
		for (const delta of reasoningDeltas) {
			const parsed = threadDeltaSchema.safeParse(delta);
			assert.ok(parsed.success, `Delta must be valid: ${JSON.stringify(delta)}`);
			if (delta.kind === "item.open") {
				assert.equal((delta.key as Record<string, unknown>).parentRef, "call-delegation-1");
				assert.equal((delta.item as Record<string, unknown>).parentToolCallId, "call-delegation-1");
			}
		}

		// Child tool start
		const toolStartDeltas = translator.translate(
			{
				type: "tool_execution_start",
				parentRef: "call-delegation-1",
				toolCallId: "call-delegation-1:cmd-1",
				toolName: "bash",
				args: { command: "npm test" },
			},
			ctx,
		);

		assert.equal(toolStartDeltas.length, 1);
		const startDelta = toolStartDeltas[0];
		assert.ok(threadDeltaSchema.safeParse(startDelta).success);
		assert.equal((startDelta.key as Record<string, unknown>).parentRef, "call-delegation-1");
		assert.equal((startDelta.item as Record<string, unknown>).parentToolCallId, "call-delegation-1");

		// Child tool update
		const toolUpdateDeltas = translator.translate(
			{
				type: "tool_execution_update",
				parentRef: "call-delegation-1",
				toolCallId: "call-delegation-1:cmd-1",
				toolName: "bash",
				partialResult: "PASS tests",
			},
			ctx,
		);

		assert.equal(toolUpdateDeltas.length, 1);
		const updateDelta = toolUpdateDeltas[0];
		assert.ok(threadDeltaSchema.safeParse(updateDelta).success);
		assert.equal((updateDelta.key as Record<string, unknown>).parentRef, "call-delegation-1");

		// Child tool end
		const toolEndDeltas = translator.translate(
			{
				type: "tool_execution_end",
				parentRef: "call-delegation-1",
				toolCallId: "call-delegation-1:cmd-1",
				toolName: "bash",
				result: "PASS tests\nOK",
				isError: false,
			},
			ctx,
		);

		assert.equal(toolEndDeltas.length, 1);
		const endDelta = toolEndDeltas[0];
		assert.ok(threadDeltaSchema.safeParse(endDelta).success);
		assert.equal((endDelta.key as Record<string, unknown>).parentRef, "call-delegation-1");
		assert.equal((endDelta.item as Record<string, unknown>).parentToolCallId, "call-delegation-1");
	});

	it("DeltaTranslator recognizes native parentToolCallId directly", () => {
		const translator = new DeltaTranslator();
		const ctx = { threadId: "thr-test", cwd: "/tmp" };

		const deltas = translator.translate(
			{
				type: "tool_execution_start",
				parentToolCallId: "native-parent-call-456",
				toolCallId: "native-parent-call-456:sub-tool",
				toolName: "bash",
				args: { command: "git status" },
			},
			ctx,
		);

		assert.equal(deltas.length, 1);
		const delta = deltas[0];
		assert.ok(threadDeltaSchema.safeParse(delta).success);
		assert.equal((delta.key as Record<string, unknown>).parentRef, "native-parent-call-456");
		assert.equal((delta.item as Record<string, unknown>).parentToolCallId, "native-parent-call-456");
	});
});
