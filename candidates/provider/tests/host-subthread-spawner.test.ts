import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, spawnSubthreadInBb } from "../src/host/subthread-spawner.ts";

test("buildSpawnArgs includes required project, parent-thread, provider, and title", () => {
	const args = buildSpawnArgs({
		projectId: "proj_personal",
		parentThreadId: "thr_parent_123",
		title: "Subagent: Fix security leak",
		task: "Fix security leak in auth controller",
	});

	assert.deepEqual(args, [
		"thread",
		"spawn",
		"--project",
		"proj_personal",
		"--parent-thread",
		"thr_parent_123",
		"--title",
		"Subagent: Fix security leak",
		"--prompt",
		"Fix security leak in auth controller",
		"--provider",
		"pi-durable",
		"--json",
	]);
});

test("spawnSubthreadInBb registers thread when CLI returns thread JSON", async () => {
	let registered: { threadId: string; conversationId: string } | undefined;
	const mockSession = {
		registerThread: (threadId: string, conversationId?: string) => {
			if (conversationId) registered = { threadId, conversationId };
		},
	};

	// Mock spawner function injecting simulated JSON output
	await spawnSubthreadInBb(
		{
			projectId: "proj_personal",
			parentThreadId: "thr_parent_123",
			title: "Subagent: Audit",
			task: "Audit",
			conversationId: "2",
		},
		mockSession,
		{
			execCommand: async () => JSON.stringify({ id: "thr_child_456", ok: true }),
		},
	);

	assert.deepEqual(registered, {
		threadId: "thr_child_456",
		conversationId: "2",
	});
});
