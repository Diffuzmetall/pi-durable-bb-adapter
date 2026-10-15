import test from "node:test";
import assert from "node:assert/strict";
import { buildToolItemShape, translateToolStart, translateToolEnd } from "../src/host/tool-delta-translator.ts";

test("buildToolItemShape sets background: true for delegation by default", () => {
	const shape = buildToolItemShape("subagent", { task: "Run background audit" }, process.cwd());
	assert.equal(shape.type, "delegation");
	assert.equal(shape.background, true);
});

test("buildToolItemShape respects explicit background: false", () => {
	const shape = buildToolItemShape("subagent", { task: "Run sync task", background: false }, process.cwd());
	assert.equal(shape.type, "delegation");
	assert.equal(shape.background, false);
});

test("translateToolStart and translateToolEnd preserve background flag", () => {
	const startEvent: any = {
		toolCallId: "call_bg_1",
		toolName: "subagent",
		args: { task: "Background worker", background: true },
	};
	const { shape, delta } = translateToolStart(startEvent, process.cwd());
	assert.equal(shape.background, true);
	assert.equal((delta.item as any).background, true);

	const endEvent: any = {
		toolCallId: "call_bg_1",
		toolName: "subagent",
		result: "Spawned",
		details: { conversationId: "42", background: true },
	};
	const endDelta = translateToolEnd(endEvent, shape, process.cwd());
	assert.equal((endDelta.item as any).background, true);
	assert.equal((endDelta.item as any).childRef, "42");
});
