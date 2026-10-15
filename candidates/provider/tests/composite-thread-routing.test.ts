import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderThreadId, formatProviderThreadId } from "../src/host/composite-id.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("parseProviderThreadId correctly distinguishes root session and composite child conversations", () => {
	const root = parseProviderThreadId("pi_durable_1740000000");
	assert.equal(root.sessionKey, "pi_durable_1740000000");
	assert.equal(root.conversationId, undefined);

	const child = parseProviderThreadId("pi_durable_1740000000:conv_sub123");
	assert.equal(child.sessionKey, "pi_durable_1740000000");
	assert.equal(child.conversationId, "conv_sub123");

	const emptyChild = parseProviderThreadId("pi_durable_1740000000:");
	assert.equal(emptyChild.sessionKey, "pi_durable_1740000000");
	assert.equal(emptyChild.conversationId, undefined);

	assert.equal(formatProviderThreadId("sess1", "conv2"), "sess1:conv2");
	assert.equal(formatProviderThreadId("sess1"), "sess1");
});

test("SessionRegistry shares active session across composite child threadIds", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	let closeCalled = false;

	const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];
	const unregisteredThreads: string[] = [];

	const mockSession = {
		runner: { exited: false },
		options: {
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root123",
		},
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThreads.push({ threadId, conversationId });
		},
		unregisterThread: (threadId: string) => {
			unregisteredThreads.push(threadId);
		},
		closeGracefully: async () => {
			closeCalled = true;
		},
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry((method, params) => {
		notifications.push({ method, params });
	});

	// Register parent session
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent", mockSession);

	// Child thread connects with composite providerThreadId
	const childSession = await registry.createOrGet("thr_child", "pi_durable_root123:conv_child99", {
		cwd: "/test",
	});

	// Should reuse the exact same session instance
	assert.equal(childSession, mockSession);
	assert.equal(registry.get("thr_child"), mockSession);
	assert.deepEqual(registeredThreads, [{ threadId: "thr_child", conversationId: "conv_child99" }]);

	// Should have emitted identity and delta reset for child thread
	assert.equal(notifications.length, 2);
	assert.equal(notifications[0].method, "thread/identity");
	assert.equal(notifications[0].params.threadId, "thr_child");
	assert.equal(notifications[0].params.providerThreadId, "pi_durable_root123:conv_child99");

	// Stopping child thread should NOT close parent session
	await registry.stop("thr_child");
	assert.deepEqual(unregisteredThreads, ["thr_child"]);
	assert.equal(registry.get("thr_child"), undefined);
	assert.equal(registry.get("thr_parent"), mockSession);
	assert.equal(closeCalled, false, "Parent session must remain alive when child thread stops");

	// Stopping parent thread should now close the session
	await registry.stop("thr_parent");
	assert.equal(closeCalled, true, "Session must close when last referencing thread stops");
});

test("bridge-router propagates conversationId to session prompt, steer, and abort", async () => {
	let promptArgs: { text: string; conversationId?: string } | undefined;
	let steerArgs: { text: string; conversationId?: string } | undefined;
	let abortArgs: { conversationId?: string } | undefined;

	const mockSession = {
		runner: { exited: false },
		options: {
			threadId: "thr_child",
			providerThreadId: "pi_durable_root:conv_child99",
		},
		prompt: async (text: string, conversationId?: string) => {
			promptArgs = { text, conversationId };
		},
		steer: async (text: string, conversationId?: string) => {
			steerArgs = { text, conversationId };
		},
		abort: async (conversationId?: string) => {
			abortArgs = { conversationId };
		},
		getLastCheckpointId: () => "chk_child_1",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child", mockSession);

	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: (id: string | number, code: number, message: string) => errors.push({ id, code, message }),
	};

	// Test TurnStart
	const { handleTurnStart, handleTurnSteer, handleThreadStop } = await import("../src/host/bridge-router.ts");
	await handleTurnStart("req_1", {
		threadId: "thr_child",
		providerThreadId: "pi_durable_root:conv_child99",
		input: [{ type: "text", text: "child task input" }],
	}, ctx);

	assert.deepEqual(promptArgs, { text: "child task input", conversationId: "conv_child99" });

	// Test TurnSteer
	await handleTurnSteer("req_2", {
		threadId: "thr_child",
		providerThreadId: "pi_durable_root:conv_child99",
		input: [{ type: "text", text: "child steer input" }],
	}, ctx);

	assert.deepEqual(steerArgs, { text: "child steer input", conversationId: "conv_child99" });

	// Test ThreadStop interrupt
	await handleThreadStop("req_3", {
		threadId: "thr_child",
		providerThreadId: "pi_durable_root:conv_child99",
		intent: "interrupt",
	}, ctx);

	assert.deepEqual(abortArgs, { conversationId: "conv_child99" });
});

test("handleActiveSessionCommand targets child conversation when conversationId is provided", async () => {
	const { handleActiveSessionCommand } = await import("../src/runner/session-commands.ts");

	let submitCalledWith: unknown;
	let abortCalled = false;
	const mockChildConv = {
		submit: async (req: unknown) => {
			submitCalledWith = req;
		},
		abort: async () => {
			abortCalled = true;
		},
	};

	let requestedConvId: string | undefined;
	const mockDurable = {
		harness: {
			conversation: async (convId: string) => {
				requestedConvId = convId;
				return mockChildConv;
			},
		},
		controller: {
			submit: async () => {
				assert.fail("root controller submit should not be called when conversationId is present");
			},
			abort: async () => {
				assert.fail("root controller abort should not be called when conversationId is present");
			},
		},
	};

	const successes: Array<{ command: string }> = [];
	const responder = {
		success: (_id: unknown, command: string) => successes.push({ command }),
		error: (_id: unknown, _cmd: unknown, msg: string) => {
			throw new Error(`Unexpected error: ${msg}`);
		},
	};

	// 1. Prompt on child
	await handleActiveSessionCommand(
		{ type: "prompt", message: "child prompt", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.equal(requestedConvId, 99);
	assert.deepEqual(submitCalledWith, { type: "input", content: "child prompt", whenBusy: "followUp" });

	// 2. Steer on child
	await handleActiveSessionCommand(
		{ type: "steer", message: "child steer", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.deepEqual(submitCalledWith, { type: "input", content: "child steer", whenBusy: "steer" });

	// 3. Abort on child
	await handleActiveSessionCommand(
		{ type: "abort", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.equal(abortCalled, true);
});
