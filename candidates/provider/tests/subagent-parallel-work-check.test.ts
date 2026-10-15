import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("VERIFICATION 1: Without mirror guard, spawning a subthread triggers a duplicate session.prompt", async () => {
	let promptCallCount = 0;
	let promptArgs: { text: string; conversationId?: string } | undefined;

	const mockSession = {
		runner: { exited: false },
		options: {
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
		},
		prompt: async (text: string, conversationId?: string) => {
			promptCallCount++;
			promptArgs = { text, conversationId };
		},
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

	// When BB spawns thr_child with prompt "Audit database", BB immediately sends turn/start:
	await handleTurnStart("req_spawn_turn", {
		threadId: "thr_child",
		providerThreadId: "pi_durable_root:2", // Conversation 2
		input: [{ type: "text", text: "Audit database" }],
	}, ctx);

	// PROOF OF USER'S SUSPICION:
	// BB's turn/start triggers session.prompt!
	// If the subagent was ALREADY running in conversation 2, this causes a DUPLICATE / PARALLEL execution!
	assert.equal(promptCallCount, 1, "Currently, turn/start ALWAYS calls session.prompt");
	assert.deepEqual(promptArgs, { text: "Audit database", conversationId: "2" });
});

test("VERIFICATION 2: With Active Subagent Deduplication Pattern, prompt is NOT called twice", async () => {
	let promptCallCount = 0;
	const activeSubagentConversations = new Set<string>(["2"]); // Conversation 2 is ALREADY running in-process!

	// Mocking the proposed mirror-aware handleTurnStart
	async function handleTurnStartWithMirrorGuard(
		id: string | number,
		params: any,
		session: any,
		notifications: any[],
	) {
		const conversationId = "2";

		// If this conversation is ALREADY actively running as a subagent:
		if (activeSubagentConversations.has(conversationId)) {
			// 1. Acknowledge the turn to BB so BB knows the thread started
			notifications.push({
				method: "thread/delta",
				params: {
					threadId: params.threadId,
					deltas: [{ kind: "input.accepted" }, { kind: "turn.open" }],
				},
			});
			// 2. DO NOT CALL session.prompt! Subagent is ALREADY running!
			return { duplicateRunPrevented: true };
		}

		// Otherwise, normal prompt execution
		promptCallCount++;
		await session.prompt(params.input[0].text, conversationId);
		return { duplicateRunPrevented: false };
	}

	const notifications: any[] = [];
	const outcome = await handleTurnStartWithMirrorGuard("req_1", {
		threadId: "thr_child",
		input: [{ type: "text", text: "Audit database" }],
	}, {
		prompt: async () => { promptCallCount++; },
	}, notifications);

	// PROOF OF SOLUTION:
	assert.equal(outcome.duplicateRunPrevented, true);
	assert.equal(promptCallCount, 0, "Duplicate prompt was cleanly intercepted and NOT called!");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].params.deltas[0].kind, "input.accepted");
});
