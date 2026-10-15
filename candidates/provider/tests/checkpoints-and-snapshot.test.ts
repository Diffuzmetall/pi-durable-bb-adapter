import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type {
	BBWireEvent,
	BBTurnEndEvent,
	BBAgentEndEvent,
	BBAutoRetryStartEvent,
	BBAutoRetryEndEvent,
} from "../src/runner/bridge/contracts.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

test("BBEventAdapter: turn_end and run_end extract providerCheckpointId from conversation tail entry", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const viewWithEntries = {
		conversation: {
			entries: [
				{ id: 101, kind: "pi.user" },
				{
					id: 102,
					kind: "pi.assistant",
					model: [{ role: "assistant", content: [{ type: "text", text: "Checkpoint test" }] }],
				},
			],
			docs: {},
		},
	} as unknown as DurableView;

	adapter.handleEvent({ type: "turn_end" }, viewWithEntries);
	adapter.handleEvent({ type: "run_end", inputs: [] }, viewWithEntries);

	const turnEnd = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	const agentEnd = emitted.find((e): e is BBAgentEndEvent => e.type === "agent_end");

	assert.ok(turnEnd, "turn_end must be emitted");
	assert.equal(turnEnd.providerCheckpointId, "102", "turn_end must reflect tail entry ID");

	assert.ok(agentEnd, "agent_end must be emitted");
	assert.equal(agentEnd.providerCheckpointId, "102", "agent_end must reflect tail entry ID");
});

test("BBEventAdapter: snapshot initializes lastCheckpointId across entries and view shapes", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const emptyView = { conversation: { entries: [], docs: {} } } as unknown as DurableView;

	// 1. Snapshot with entries array
	const snapshotWithEntries = {
		type: "snapshot",
		entries: [{ id: 501 }, { id: 502 }],
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: {},
	} as unknown as AgentEvent;

	adapter.handleEvent(snapshotWithEntries, emptyView);
	// Subsequent turn_end without view entries should still use the snapshot checkpoint
	adapter.handleEvent({ type: "turn_end" }, emptyView);

	const turnEnd1 = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	assert.ok(turnEnd1);
	assert.equal(turnEnd1.providerCheckpointId, "502", "Snapshot entries tail should initialize checkpoint");

	// 2. Snapshot with nested view.conversation.entries
	emitted.length = 0;
	const snapshotWithView = {
		type: "snapshot",
		entries: [],
		view: {
			conversation: {
				entries: [{ id: 777 }],
			},
		},
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: {},
	} as unknown as AgentEvent;

	adapter.handleEvent(snapshotWithView, emptyView);
	adapter.handleEvent({ type: "turn_end" }, emptyView);

	const turnEnd2 = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	assert.ok(turnEnd2);
	assert.equal(turnEnd2.providerCheckpointId, "777", "Snapshot view.conversation.entries should initialize checkpoint");
});

test("BBEventAdapter: auto_retry_start and auto_retry_end wire event translations", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = { conversation: { entries: [], docs: {} } } as unknown as DurableView;

	adapter.handleEvent(
		{
			type: "auto_retry_start",
			attempt: 2,
			at: 1728345678,
			errorMessage: "Rate limit reached (429)",
		},
		dummyView,
	);

	adapter.handleEvent(
		{
			type: "auto_retry_end",
			attempt: 2,
		},
		dummyView,
	);

	const retryStart = emitted.find((e): e is BBAutoRetryStartEvent => e.type === "auto_retry_start");
	assert.ok(retryStart, "auto_retry_start must be emitted");
	assert.equal(retryStart.attempt, 2);
	assert.equal(retryStart.at, 1728345678);
	assert.equal(retryStart.errorMessage, "Rate limit reached (429)");

	const retryEnd = emitted.find((e): e is BBAutoRetryEndEvent => e.type === "auto_retry_end");
	assert.ok(retryEnd, "auto_retry_end must be emitted");
	assert.equal(retryEnd.attempt, 2);
});

test("translateAgentEnd: attaches providerCheckpointId to turn.boundary and validates with threadDeltaSchema", () => {
	// Case A: Event with providerCheckpointId
	const eventWithCheckpoint = {
		type: "agent_end",
		providerCheckpointId: "chk_999",
		messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "Done" }] }],
	};

	const resWithCheckpoint = translateAgentEnd(eventWithCheckpoint, "Pending text", false);
	assert.equal(resWithCheckpoint.turnBoundarySent, true);

	const boundaryDelta = resWithCheckpoint.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryDelta, "turn.boundary must be emitted");
	assert.equal(boundaryDelta.providerCheckpointId, "chk_999");
	assert.equal(boundaryDelta.status, "completed");
	assert.equal(boundaryDelta.claimIfIdle, true);

	// Validate against official Beyond Boundaries SDK schema
	const parseResult = threadDeltaSchema.safeParse(boundaryDelta);
	assert.equal(parseResult.success, true, "turn.boundary delta must strictly validate against threadDeltaSchema");

	// Case B: Event without providerCheckpointId (backwards compatibility)
	const eventWithoutCheckpoint = {
		type: "agent_end",
		messages: [],
	};
	const resWithout = translateAgentEnd(eventWithoutCheckpoint, "", false);
	const boundaryWithout = resWithout.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryWithout);
	assert.equal(boundaryWithout.providerCheckpointId, undefined);

	const parseResultWithout = threadDeltaSchema.safeParse(boundaryWithout);
	assert.equal(parseResultWithout.success, true);
});

test("DeltaTranslator: end-to-end integration preserves providerCheckpointId on turn.boundary", () => {
	const translator = new DeltaTranslator();
	const ctx = { threadId: "thr_integration" };

	translator.translate({ type: "agent_start" }, ctx);
	const deltas = translator.translate(
		{
			type: "agent_end",
			providerCheckpointId: "entry_456",
			messages: [],
		},
		ctx,
	);

	const boundary = deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundary, "DeltaTranslator must emit turn.boundary on agent_end");
	assert.equal(boundary.providerCheckpointId, "entry_456");

	const validation = threadDeltaSchema.safeParse(boundary);
	assert.equal(validation.success, true);
});
