import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type {
	BBWireEvent,
	BBTurnEndEvent,
	BBAgentEndEvent,
} from "../src/runner/bridge/contracts.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("translateAgentEnd: translates aborted turn to status 'interrupted' in turn.boundary", () => {
	// Case A: event.aborted === true
	const eventAborted: RunnerEvent = {
		type: "agent_end",
		aborted: true,
		providerCheckpointId: "chk_abort_1",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Cancelled work" }] }],
	};
	const resA = translateAgentEnd(eventAborted, "", false);
	const boundaryA = resA.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryA, "turn.boundary must be emitted");
	assert.equal(boundaryA.status, "interrupted");
	assert.equal(boundaryA.claimIfIdle, true);
	assert.equal(boundaryA.providerCheckpointId, "chk_abort_1");
	assert.equal(threadDeltaSchema.safeParse(boundaryA).success, true);

	// Case B: event.stopReason === 'aborted'
	const eventStopReason: RunnerEvent = {
		type: "agent_end",
		stopReason: "aborted",
		messages: [],
	};
	const resB = translateAgentEnd(eventStopReason, "", false);
	const boundaryB = resB.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryB);
	assert.equal(boundaryB.status, "interrupted");
	assert.equal(threadDeltaSchema.safeParse(boundaryB).success, true);

	// Case C: assistant message stopReason === 'aborted'
	const eventMsgAborted: RunnerEvent = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Partial output" }],
				stopReason: "aborted",
			},
		],
	};
	const resC = translateAgentEnd(eventMsgAborted, "", false);
	const boundaryC = resC.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryC);
	assert.equal(boundaryC.status, "interrupted");
	assert.equal(threadDeltaSchema.safeParse(boundaryC).success, true);

	// Case D: regular non-aborted completion translates to 'completed'
	const eventCompleted: RunnerEvent = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Complete" }],
				stopReason: "stop",
			},
		],
	};
	const resD = translateAgentEnd(eventCompleted, "", false);
	const boundaryD = resD.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryD);
	assert.equal(boundaryD.status, "completed");
	assert.equal(threadDeltaSchema.safeParse(boundaryD).success, true);
});

test("threadDeltaSchema: validates session.ended delta strictly", () => {
	const sessionEndedDelta = { kind: "session.ended" };
	const parseResult = threadDeltaSchema.safeParse(sessionEndedDelta);
	assert.equal(parseResult.success, true, "session.ended must strictly conform to threadDeltaSchema");
});

test("BBEventAdapter: propagates stopReason 'aborted' into turn_end and agent_end wire events", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const viewWithAbortedEntry = {
		conversation: {
			entries: [
				{
					id: 201,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Interrupted partial" }],
							stopReason: "aborted",
						},
					],
				},
			],
			docs: {},
		},
	} as unknown as DurableView;

	adapter.handleEvent({ type: "turn_end" }, viewWithAbortedEntry);
	adapter.handleEvent({ type: "run_end", inputs: [] }, viewWithAbortedEntry);

	const turnEnd = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	assert.ok(turnEnd, "turn_end wire event must be emitted");
	assert.equal(turnEnd.aborted, true, "turn_end must have aborted: true");
	assert.equal(turnEnd.stopReason, "aborted");
	assert.equal(turnEnd.message?.stopReason, "aborted");

	const agentEnd = emitted.find((e): e is BBAgentEndEvent => e.type === "agent_end");
	assert.ok(agentEnd, "agent_end wire event must be emitted");
	assert.equal(agentEnd.aborted, true, "agent_end must have aborted: true");
	assert.equal(agentEnd.stopReason, "aborted");
	assert.equal(agentEnd.messages[0]?.stopReason, "aborted");
});

test("BBEventAdapter: multi-turn isolation prevents aborted Turn 1 from contaminating completed Turn 2 (P1 fix)", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	// Multi-turn conversation: Turn 1 was aborted, Turn 2 finished normally with stopReason 'stop'
	const multiTurnView = {
		conversation: {
			entries: [
				{ id: 1, kind: "pi.user" },
				{
					id: 2,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Turn 1 was stopped" }],
							stopReason: "aborted",
						},
					],
				},
				{ id: 3, kind: "pi.user" },
				{
					id: 4,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Turn 2 succeeded" }],
							stopReason: "stop",
						},
					],
				},
			],
			docs: {},
		},
	} as unknown as DurableView;

	adapter.handleEvent({ type: "turn_end" }, multiTurnView);

	const turnEnd = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	assert.ok(turnEnd, "turn_end wire event must be emitted");
	assert.equal(turnEnd.aborted, undefined, "Turn 2 must NOT be marked aborted");
	assert.equal(turnEnd.stopReason, undefined, "Turn 2 must NOT have aborted stopReason");
	assert.equal(turnEnd.message?.stopReason, "stop", "Turn 2 stopReason must remain 'stop'");

	// Translation to turn.boundary must emit status 'completed', not 'interrupted'
	const deltas = translateAgentEnd(
		{
			type: "agent_end",
			message: turnEnd.message,
		},
		"",
		false,
	).deltas;
	const boundary = deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundary);
	assert.equal(boundary.status, "completed", "Turn 2 boundary status must be 'completed'");
});
