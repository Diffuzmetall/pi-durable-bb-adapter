import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	nativeChildKey,
	projectNativeChildInBb,
	type NativeChildDescriptor,
} from "../src/host/native-child-binding.ts";
import { projectSubthreadInBb, spawnSubthreadInBb } from "../src/host/subthread-spawner.ts";

const child: NativeChildDescriptor = {
	backendId: "backend-a",
	sessionId: "session-a",
	conversationId: "child-1",
	parentThreadId: "bb-parent",
	title: "Already running in Durable",
};
const owner = { backendId: child.backendId, sessionId: child.sessionId, parentThreadId: child.parentThreadId };

test("unsupported native registration returns an explicit unbound identity, never a fake BB thread", () => {
	assert.deepEqual(projectNativeChildInBb(child, owner), {
		status: "projection-unavailable",
		reason: "unsupported-registration-port",
		key: '["backend-a","session-a","child-1"]',
		binding: { backendId: "backend-a", sessionId: "session-a", conversationId: "child-1",
			parentThreadId: "bb-parent", bbThreadId: null },
	});
});

test("repeated and concurrent events remain refused without a process-local success cache", async () => {
	const before = projectNativeChildInBb(child, owner);
	const retries = await Promise.all(Array.from({ length: 20 }, async () => projectNativeChildInBb(child, owner)));
	for (const retry of retries) assert.deepEqual(retry, before);
	assert.deepEqual(projectNativeChildInBb({ ...child, title: "Renamed" }, owner), before);
	assert.deepEqual(projectNativeChildInBb(JSON.parse(JSON.stringify(child)), owner), before);
});

test("identity keys isolate backend and session, including separator-like identifiers", () => {
	const identities = [child, { ...child, backendId: "backend-b" }, { ...child, sessionId: "session-b" },
		{ ...child, backendId: "a/b", sessionId: "c" }, { ...child, backendId: "a", sessionId: "b/c" }];
	assert.equal(new Set(identities.map(nativeChildKey)).size, identities.length);
});

test("foreign backend/session/BB parent are refused without returning binding data", () => {
	for (const field of ["backendId", "sessionId", "parentThreadId"] as const) {
		assert.deepEqual(projectNativeChildInBb({ ...child, [field]: "foreign" }, owner), {
			status: "projection-unavailable", reason: "owner-mismatch",
		});
	}
});

test("blank and non-string identity fields are refused, not coerced into another conversation", () => {
	for (const field of ["backendId", "sessionId", "conversationId", "parentThreadId"] as const) {
		for (const value of ["", "  ", 1, undefined]) {
			assert.deepEqual(projectNativeChildInBb({ ...child, [field]: value } as NativeChildDescriptor, owner), {
				status: "projection-unavailable", reason: "invalid-identity",
			});
		}
	}
	assert.throws(() => nativeChildKey({ ...child, conversationId: "" }), TypeError);
});

test("returned unbound identity is copied and immutable", () => {
	const input = { ...child };
	const result = projectNativeChildInBb(input, owner);
	input.conversationId = "changed";
	assert.equal(result.binding?.conversationId, child.conversationId);
	assert.equal(Object.isFrozen(result.binding), true);
});

test("existing lifecycle entrypoint never spawns, submits, registers, or reads missing project settings", async () => {
	let commands = 0;
	let registrations = 0;
	let submits = 0;
	const session = {
		registerThread() { registrations++; throw new Error("registration must not run"); },
		submit() { submits++; throw new Error("native child must not be submitted again"); },
	};
	const execCommand = async () => { commands++; throw new Error("CLI must not run"); };
	for (const options of [{ execCommand }, { execCommand, owner }]) {
		for (let n = 0; n < 2; n++) {
			assert.equal(await spawnSubthreadInBb({ ...child, task: "Never send this prompt" }, session, options), undefined);
		}
	}
	assert.deepEqual({ commands, registrations, submits }, { commands: 0, registrations: 0, submits: 0 });
	assert.deepEqual(projectSubthreadInBb({ ...child, task: "ignored" }), {
		status: "projection-unavailable", reason: "unsupported-registration-port",
	});
	assert.equal(projectSubthreadInBb({ ...child, task: "ignored" }, owner).key, nativeChildKey(child));
});

test("projection module dependency boundary excludes CLI, SQLite, Harness and model submission", () => {
	for (const file of ["native-child-binding.ts", "subthread-spawner.ts"]) {
		const source = readFileSync(new URL(`../src/host/${file}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /node:(?:child_process|sqlite)|--prompt|\.submit\s*\(|new Harness|resolveProjectIdFromDb/);
	}
});
