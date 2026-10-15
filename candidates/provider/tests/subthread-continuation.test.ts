import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import type { PiThreadSession } from "../src/host/session.ts";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";

test("User can continue conversation in subthread after subagent initial run completes", async () => {
	const mirrors = new SubagentMirrorManager();
	mirrors.markActive("2", { task: "Audit" });
	mirrors.markCompleted("2", "All clean");

	let promptCalls = 0;
	let lastPromptText = "";
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	const mockSession = {
		runner: { exited: false },
		options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
		prompt: async (text: string) => {
			promptCalls++;
			lastPromptText = text;
		},
		getSubagentState: (convId: string) => mirrors.getState(convId),
		consumeCompletedMirror: (convId: string) => mirrors.consumeCompleted(convId),
		registerThread: () => {},
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child", mockSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	// 1. Initial turn/start from BB for the spawned subthread (subagent already completed)
	await handleTurnStart(
		"turn_init",
		{
			threadId: "thr_child",
			providerThreadId: "pi_durable_root:2",
			input: [{ type: "text", text: "Audit" }],
			clientRequestId: "creq_init",
		},
		ctx,
	);

	assert.equal(promptCalls, 0, "Initial spawn turn must NOT trigger prompt");
	assert.equal(mirrors.getState("2"), undefined, "Completed mirror must be consumed after initial turn acknowledgement");

	// 2. User interactive follow-up turn in the subthread
	await handleTurnStart(
		"turn_user_followup",
		{
			threadId: "thr_child",
			providerThreadId: "pi_durable_root:2",
			input: [{ type: "text", text: "Please explain the clean status in detail" }],
			clientRequestId: "creq_user_1",
		},
		ctx,
	);

	assert.equal(promptCalls, 1, "User follow-up prompt MUST be called");
	assert.equal(lastPromptText, "Please explain the clean status in detail");
});
