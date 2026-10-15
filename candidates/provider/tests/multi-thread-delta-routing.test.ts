import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiThreadSession } from "../src/host/session.ts";
import type { SessionOptions, RunnerEvent } from "../src/host/types.ts";

test("PiThreadSession routes deltas to child threadId when conversation is registered", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const options: SessionOptions = {
		threadId: "thr_parent",
		providerThreadId: "pi_durable_root",
		sessionFilePath: join(tmpdir(), `session-${Date.now()}-routing.sqlite`),
		sessionDir: tmpdir(),
		extensionPath: "/tmp/fake-ext.mjs",
		scratchDir: "/tmp/scratch",
	};

	const session = new PiThreadSession(options, (method, params) => {
		notifications.push({ method, params });
	});

	try {
		// Register a child thread associated with conversationId "2"
		session.registerThread("thr_child", "2");

		// 1. Root conversation event -> goes to thr_parent
		const rootEvent: RunnerEvent = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello from root",
			},
		};
		await (session as any).handleRunnerEvent(rootEvent);

		const rootDeltas = notifications.filter(n => n.params.threadId === "thr_parent");
		assert.ok(rootDeltas.length > 0, "Root deltas must route to thr_parent");
		assert.equal(notifications.filter(n => n.params.threadId === "thr_child").length, 0);

		// 2. Child conversation event with conversationId 2 -> goes to thr_child!
		const childEvent: RunnerEvent = {
			type: "message_update",
			conversationId: 2,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello from child",
			},
		};
		await (session as any).handleRunnerEvent(childEvent);

		const childDeltas = notifications.filter(n => n.params.threadId === "thr_child");
		assert.ok(childDeltas.length > 0, "Child deltas must route to thr_child");

		// 3. In-process subagent (has parentRef, no separate threadId registered) -> goes to thr_parent with parentRef
		const subagentEvent: RunnerEvent = {
			type: "message_update",
			conversationId: 99, // Unregistered conversationId (pure in-process subagent)
			parentRef: "call_subagent_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Subagent thoughts",
			},
		};
		await (session as any).handleRunnerEvent(subagentEvent);

		const subagentDeltas = notifications.filter(n => n.params.threadId === "thr_parent");
		const lastDelta = subagentDeltas.at(-1)?.params.deltas as any[];
		assert.ok(lastDelta, "Subagent delta must route to thr_parent");
		assert.equal(lastDelta[0].key?.parentRef, "call_subagent_1");

		// 4. Unregistering child thread cleans up mapping
		session.unregisterThread("thr_child");
		assert.equal(session.getThreadIdForConversation("2"), undefined);
	} finally {
		session.kill();
	}
});
