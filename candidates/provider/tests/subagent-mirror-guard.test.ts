import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("handleTurnStart intercepts running subagent turn and suppresses duplicate session.prompt", async () => {
	let promptCalls = 0;
	let registeredThread: { threadId: string; conversationId?: string } | undefined;
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	const mockSession = {
		runner: { exited: false },
		options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
		prompt: async () => {
			promptCalls++;
		},
		getSubagentState: (convId: string) => (convId === "2" ? { status: "running", task: "Audit" } : undefined),
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThread = { threadId, conversationId };
		},
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child", mockSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	await handleTurnStart(
		"req_spawn_1",
		{
			threadId: "thr_child",
			providerThreadId: "pi_durable_root:2",
			input: [{ type: "text", text: "Audit" }],
			clientRequestId: "creq_23456789ab",
		},
		ctx,
	);

	// 1. Duplicate prompt was NOT called
	assert.equal(promptCalls, 0, "session.prompt must not be called for an actively running subagent");

	// 2. Thread was registered with conversation
	assert.deepEqual(registeredThread, { threadId: "thr_child", conversationId: "2" });

	// 3. Turn was acknowledged to BB
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "req_spawn_1");

	// 4. input.accepted was emitted so UI knows turn started
	const acceptedDelta = notifications.find((n) => n.method === "thread/delta");
	assert.ok(acceptedDelta);
	assert.equal(acceptedDelta?.params.threadId, "thr_child");
});

test("handleTurnStart handles completed subagent race condition and emits turn.boundary", async () => {
	let promptCalls = 0;
	let registeredThread: { threadId: string; conversationId?: string } | undefined;
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	const mockSession = {
		runner: { exited: false },
		options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
		prompt: async () => {
			promptCalls++;
		},
		getSubagentState: (convId: string) =>
			convId === "2" ? { status: "completed", task: "Audit", result: "0 issues" } : undefined,
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThread = { threadId, conversationId };
		},
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child", mockSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	await handleTurnStart(
		"req_spawn_2",
		{
			threadId: "thr_child",
			providerThreadId: "pi_durable_root:2",
			input: [{ type: "text", text: "Audit" }],
			clientRequestId: "creq_23456789cd",
		},
		ctx,
	);

	// Duplicate prompt was NOT called
	assert.equal(promptCalls, 0);
	assert.deepEqual(registeredThread, { threadId: "thr_child", conversationId: "2" });

	// Turn boundary was emitted to close the turn
	const boundaryNotification = notifications.find(
		(n) =>
			n.method === "thread/delta" &&
			Array.isArray(n.params.deltas) &&
			(n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
	);
	assert.ok(boundaryNotification, "turn.boundary must be emitted for late turn/start on completed subagent");
});
