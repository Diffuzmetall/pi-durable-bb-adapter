import test from "node:test";
import assert from "node:assert/strict";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { parseConversationId } from "../src/runner/session-commands.ts";

test("parseConversationId accepts valid numeric and string IDs", () => {
	// Undefined / null -> defaults to root conversation id (1)
	assert.equal(parseConversationId(undefined), ROOT_CONVERSATION_ID);
	assert.equal(parseConversationId(null as any), ROOT_CONVERSATION_ID);

	// Numbers
	assert.equal(parseConversationId(1), 1);
	assert.equal(parseConversationId(2), 2);
	assert.equal(parseConversationId(42), 42);

	// Strings representing positive integers
	assert.equal(parseConversationId("1"), 1);
	assert.equal(parseConversationId("2"), 2);
	assert.equal(parseConversationId("42"), 42);
	assert.equal(parseConversationId("  10  "), 10);
});

test("parseConversationId throws on invalid or non-positive IDs", () => {
	assert.throws(() => parseConversationId(0), /Invalid conversationId/);
	assert.throws(() => parseConversationId(-5), /Invalid conversationId/);
	assert.throws(() => parseConversationId(1.5), /Invalid conversationId/);
	assert.throws(() => parseConversationId("0"), /Invalid conversationId/);
	assert.throws(() => parseConversationId("-1"), /Invalid conversationId/);
	assert.throws(() => parseConversationId("abc"), /Invalid conversationId/);
	assert.throws(() => parseConversationId(""), /Invalid conversationId/);
	assert.throws(() => parseConversationId("   "), /Invalid conversationId/);
});
