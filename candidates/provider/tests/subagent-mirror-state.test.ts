import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";

test("PiThreadSession tracks subagent mirror lifecycle (active -> completed)", () => {
	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		() => {},
	);

	try {
		assert.equal(session.getSubagentState("2"), undefined);

		session.markSubagentActive("2", { task: "Audit code", parentToolCallId: "call_1" });
		assert.deepEqual(session.getSubagentState("2"), {
			status: "running",
			task: "Audit code",
			parentToolCallId: "call_1",
		});

		session.markSubagentCompleted("2", "Audit passed: 0 findings");
		assert.deepEqual(session.getSubagentState("2"), {
			status: "completed",
			task: "Audit code",
			parentToolCallId: "call_1",
			result: "Audit passed: 0 findings",
		});
	} finally {
		session.kill();
	}
});
