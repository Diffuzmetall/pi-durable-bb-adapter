import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	handleThreadStop,
	type BridgeRouterContext,
	type ThreadStopParams,
} from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { RunnerEvent } from "../src/host/types.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("handleThreadStop: intent 'interrupt' emits session.ended, aborts session, returns providerCheckpointId", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	let abortCalled = false;
	const mockSession = {
		runner: { exited: false },
		abort: async () => {
			abortCalled = true;
		},
		getLastCheckpointId: () => "chk_last_42",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_interrupt_1", mockSession);

	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	const params: ThreadStopParams = {
		threadId: "thr_interrupt_1",
		intent: "interrupt",
		activeTurnId: "turn_999",
	};

	await handleThreadStop("req_stop_1", params, ctx);

	// 1. Session abort was called
	assert.equal(abortCalled, true, "session.abort() must be called on intent 'interrupt'");

	// 2. session.ended delta was emitted
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].method, "thread/delta");
	assert.equal(notifications[0].params.threadId, "thr_interrupt_1");
	const deltas = notifications[0].params.deltas as Array<{ kind: string }>;
	assert.deepEqual(deltas, [{ kind: "session.ended" }]);
	assert.equal(threadDeltaSchema.safeParse(deltas[0]).success, true);

	// 3. Response contains ok: true and providerCheckpointId
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "req_stop_1");
	assert.deepEqual(results[0].result, {
		ok: true,
		providerCheckpointId: "chk_last_42",
	});

	// 4. Session is NOT stopped/purged from registry
	assert.equal(registry.get("thr_interrupt_1"), mockSession);
});

test("handleThreadStop: intent 'interrupt' without active session returns null checkpointId", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	const registry = new SessionRegistry(() => {});
	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	await handleThreadStop("req_stop_2", { threadId: "thr_unknown", intent: "interrupt" }, ctx);

	assert.equal(notifications.length, 0, "No notifications emitted when session is absent");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].result, { ok: true, providerCheckpointId: null });
});

test("handleThreadStop: intent 'release' stops session in registry and returns ok: true", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	let closeCalled = false;
	const mockSession = {
		runner: { exited: false },
		closeGracefully: async () => {
			closeCalled = true;
		},
		getLastCheckpointId: () => "chk_33",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_release_1", mockSession);

	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	await handleThreadStop("req_stop_3", { threadId: "thr_release_1", intent: "release" }, ctx);

	assert.equal(closeCalled, true, "Session must be closed on release");
	assert.equal(registry.get("thr_release_1"), undefined, "Session must be removed from registry on release");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].result, { ok: true });
});

test("PiThreadSession: retains lastCheckpointId from incoming runner events", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const sessionClass = (await import("../src/host/session.ts")).PiThreadSession;

	const session = new sessionClass(
		{
			threadId: "thr_chk_test",
			providerThreadId: "pi_chk_test",
			sessionFilePath: "/tmp/fake.jsonl",
			sessionDir: "/tmp",
			extensionPath: "/tmp",
			scratchDir: "/tmp",
		},
		(method, params) => notifications.push({ method, params }),
	);

	assert.equal(session.getLastCheckpointId(), null, "Initial checkpointId must be null");

	const handleEvent = (session as unknown as { handleRunnerEvent: (e: RunnerEvent) => Promise<void> }).handleRunnerEvent.bind(session);

	try {
		await handleEvent({
			type: "snapshot",
			providerCheckpointId: "chk_init_001",
		});
		assert.equal(session.getLastCheckpointId(), "chk_init_001");

		await handleEvent({
			type: "agent_end",
			providerCheckpointId: "chk_turn_002",
			messages: [],
		});
		assert.equal(session.getLastCheckpointId(), "chk_turn_002");
	} finally {
		session.kill();
	}
});
