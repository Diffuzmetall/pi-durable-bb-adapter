import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBridge } from "../src/host/bridge.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";

test("ProviderBridge returns -32700 Parse error on malformed JSON without throwing", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine("this is not valid json");

	assert.equal(sent.length, 1);
	const response = JSON.parse(sent[0]);
	assert.equal(response.error.code, -32700);
	assert.ok(response.error.message.includes("Parse error"));
});

test("ProviderBridge handles empty and whitespace lines as no-op", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine("");
	await bridge.handleLine("   \n\t  ");

	assert.equal(sent.length, 0);
});

test("ProviderBridge returns error when steering without active session", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine(JSON.stringify({
		id: "steer_1",
		method: "turn/steer",
		params: {
			threadId: "thr_nonexistent",
			clientRequestId: "creq_test123456",
			expectedTurnId: "turn_123",
			input: [{ type: "text", text: "steer message" }],
		},
	}));

	assert.equal(sent.length, 1);
	const response = JSON.parse(sent[0]);
	assert.equal(response.id, "steer_1");
	assert.equal(response.error.code, -32000);
	assert.ok(response.error.message.includes("No active session"));
});

test("ProviderBridge thread/stop with intent 'interrupt' emits session.ended, aborts session, and does not stop registry", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	let aborted = false;
	const mockSession = {
		runner: { exited: false },
		options: { cwd: "/mock/cwd", providerThreadId: "pi_mock" },
		abort: async () => {
			aborted = true;
		},
		getLastCheckpointId: () => "chk_interrupted_1",
	} as unknown as PiThreadSession;
	const bridgeInternal = bridge as unknown as { registry: { sessions: Map<string, PiThreadSession> } };
	bridgeInternal.registry.sessions.set("thr_test", mockSession);

	await bridge.handleLine(JSON.stringify({
		id: "stop_1",
		method: "thread/stop",
		params: {
			threadId: "thr_test",
			intent: "interrupt",
			activeTurnId: "turn_abc123",
		},
	}));

	assert.equal(aborted, true);
	assert.equal(sent.length, 2);
	const notif = JSON.parse(sent[0]);
	assert.equal(notif.method, "thread/delta");
	assert.equal(notif.params.threadId, "thr_test");
	assert.deepEqual(notif.params.deltas, [{
		kind: "session.ended",
	}]);

	const response = JSON.parse(sent[1]);
	assert.equal(response.id, "stop_1");
	assert.equal(response.result.ok, true);
	assert.equal(response.result.providerCheckpointId, "chk_interrupted_1");

	// Verify session remains in registry
	assert.equal(bridgeInternal.registry.sessions.has("thr_test"), true);
});

test("ProviderBridge turn/steer emits input.accepted without providerTurnId", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	// Inject active mock session
	let steeredMessage = "";
	const mockSession = {
		runner: { exited: false },
		options: { cwd: "/mock/cwd", providerThreadId: "pi_mock" },
		steer: async (text: string) => {
			steeredMessage = text;
		},
	} as any;
	(bridge as any).registry.sessions.set("thr_active", mockSession);

	await bridge.handleLine(JSON.stringify({
		id: "steer_2",
		method: "turn/steer",
		params: {
			threadId: "thr_active",
			clientRequestId: "creq_23456789ab",
			expectedTurnId: "turn_target_456",
			input: [{ type: "text", text: "steer message text" }],
		},
	}));

	assert.equal(steeredMessage, "steer message text");
	assert.equal(sent.length, 2);

	const notif = JSON.parse(sent[0]);
	assert.equal(notif.method, "thread/delta");
	assert.equal(notif.params.threadId, "thr_active");
	assert.deepEqual(notif.params.deltas, [{
		kind: "input.accepted",
		clientRequestId: "creq_23456789ab",
	}]);

	const response = JSON.parse(sent[1]);
	assert.equal(response.id, "steer_2");
	assert.equal(response.result.threadId, "thr_active");
});

test("SessionRegistry purges dead runner from registry on get", () => {
	const registry = new SessionRegistry(() => {});

	// Inject a mock session with exited runner
	const mockSession = {
		runner: { exited: true },
		options: { cwd: "/mock/cwd", providerThreadId: "pi_mock" },
	} as any;

	(registry as any).sessions.set("thr_dead", mockSession);

	assert.equal(registry.get("thr_dead"), undefined);
	assert.equal((registry as any).sessions.has("thr_dead"), false);
});



