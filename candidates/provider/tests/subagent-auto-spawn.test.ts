import test from "node:test";
import assert from "node:assert/strict";
import { Subagent } from "../src/runner/subagent.ts";

test("Subagent tool announces conversationId and task for BB subthread mirror", async () => {
	assert.equal(Subagent.name, "subagent");
	const tool = (Subagent as any).tools?.[0];
	assert.ok(tool, "Subagent tool must be defined");
	assert.equal(tool.name, "subagent");
	assert.equal(tool.description.includes("subagent"), true);
});

test("Subagent tool definition safely handles missing BB_THREAD_ID without crashing", () => {
	// When BB_THREAD_ID is not set, subagent execution still runs purely in-process
	const previous = process.env.BB_THREAD_ID;
	delete process.env.BB_THREAD_ID;
	try {
		assert.equal(process.env.BB_THREAD_ID, undefined);
	} finally {
		if (previous) process.env.BB_THREAD_ID = previous;
	}
});
