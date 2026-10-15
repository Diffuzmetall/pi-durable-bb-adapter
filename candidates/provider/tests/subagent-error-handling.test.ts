import test from "node:test";
import assert from "node:assert/strict";
import { Subagent } from "../src/runner/subagent.ts";

test("Subagent module is exported and valid", () => {
	assert.equal(Subagent.name, "subagent");
	const tool = (Subagent as any).tools?.[0];
	assert.ok(tool);
	assert.equal(tool.name, "subagent");
});
