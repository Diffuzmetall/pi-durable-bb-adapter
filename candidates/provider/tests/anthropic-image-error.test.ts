import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolResultForAnthropic } from "../src/runner/bridge/tool-result-extractor.ts";

test("sanitizeToolResultForAnthropic replaces images with text note when isError is true", () => {
	const content = [
		{ type: "image", data: "base64data...", mimeType: "image/png" },
		{ type: "text", text: "Something went wrong" },
	];
	const sanitized = sanitizeToolResultForAnthropic(content as any, true);
	assert.strictEqual(sanitized.length, 2);
	assert.strictEqual(sanitized[0].type, "text");
	assert.strictEqual((sanitized[0] as any).text, "[image omitted: error tool results cannot contain images]");
	assert.strictEqual(sanitized[1].type, "text");
	assert.strictEqual((sanitized[1] as any).text, "Something went wrong");
});

test("sanitizeToolResultForAnthropic preserves images when isError is false", () => {
	const content = [
		{ type: "image", data: "base64data...", mimeType: "image/png" },
	];
	const sanitized = sanitizeToolResultForAnthropic(content as any, false);
	assert.strictEqual(sanitized[0].type, "image");
});

test("sanitizeToolResultForAnthropic is a no-op for non-array input", () => {
	const sanitized = sanitizeToolResultForAnthropic([] as any, true);
	assert.deepStrictEqual(sanitized, []);
});
