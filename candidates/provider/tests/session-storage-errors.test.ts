import test from "node:test";
import assert from "node:assert/strict";
import { isProcessAlive } from "../src/runner/session-storage.ts";

test("isProcessAlive accurately identifies process liveness and handles invalid pids", () => {
	assert.equal(isProcessAlive(process.pid), true);
	assert.equal(isProcessAlive(0), false);
	assert.equal(isProcessAlive(-1), false);
});
