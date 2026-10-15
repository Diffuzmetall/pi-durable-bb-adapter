import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkSessionDatabase } from "../src/host/thread-fork.ts";
import { ProviderBridge } from "../src/host/bridge.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";

class MockSessionRegistry extends SessionRegistry {
	public created: Array<{ threadId: string; providerThreadId: string }> = [];

	public override async createOrGet(
		threadId: string,
		providerThreadId: string,
		_params: Record<string, unknown>,
	): Promise<PiThreadSession> {
		this.created.push({ threadId, providerThreadId });
		const stub = { runner: { exited: false }, options: { cwd: "/mock/cwd", providerThreadId } };
		return stub as unknown as PiThreadSession;
	}
}

function createSessionDb(dir: string, entries: Array<{ id: number; record: string }>): void {
	mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, "session.sqlite"));
	db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, commit_seq INTEGER, record TEXT);");
	const insert = db.prepare("INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, 1, 1, ?)");
	for (const e of entries) insert.run(e.id, e.record);
	db.close();
}

function getEntryIds(dbPath: string): number[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT id FROM entries ORDER BY id ASC").all() as Array<{ id: number }>;
		return rows.map((r) => r.id);
	} finally {
		db.close();
	}
}

describe("Thread Fork Service and RPC (Cycle 69 - AP-013, AP-026, AP-028)", () => {
	let tempDir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-thread-fork-test-"));
		env = { ...process.env, BB_PI_BRIDGE_SESSION_DIR: tempDir };
		createSessionDb(join(tempDir, "pi_durable_parent"), [
			{ id: 1, record: '{"text":"entry 1"}' },
			{ id: 2, record: '{"text":"entry 2"}' },
			{ id: 3, record: '{"text":"entry 3"}' },
		]);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("forking without checkpoint creates child database preserving all parent entries", () => {
		forkSessionDatabase({
			sourceProviderThreadId: "pi_durable_parent",
			targetProviderThreadId: "pi_durable_child_full",
			env,
		});

		const childDbPath = join(tempDir, "pi_durable_child_full", "session.sqlite");
		assert.ok(existsSync(childDbPath), "Child database must exist on disk");
		assert.deepEqual(getEntryIds(childDbPath), [1, 2, 3]);
	});

	it("forking with checkpointId removes entries with id > checkpointId from child database", () => {
		forkSessionDatabase({
			sourceProviderThreadId: "pi_durable_parent",
			targetProviderThreadId: "pi_durable_child_cp",
			checkpointId: "2",
			env,
		});

		const childDbPath = join(tempDir, "pi_durable_child_cp", "session.sqlite");
		assert.deepEqual(getEntryIds(childDbPath), [1, 2]);

		const parentDbPath = join(tempDir, "pi_durable_parent", "session.sqlite");
		assert.deepEqual(getEntryIds(parentDbPath), [1, 2, 3]);
	});

	it("forking from non-existent parent throws descriptive error", () => {
		assert.throws(
			() => forkSessionDatabase({
				sourceProviderThreadId: "pi_durable_nonexistent",
				targetProviderThreadId: "pi_durable_child_err",
				env,
			}),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /Cannot fork: source session database not found for "pi_durable_nonexistent"/);
				return true;
			},
		);
	});

	it("forking resolves source session located in custom absolute directory path", () => {
		const customSource = join(tempDir, "pi_durable_custom_dir");
		createSessionDb(customSource, [{ id: 10, record: '{"type":"custom"}' }]);
		forkSessionDatabase({
			sourceProviderThreadId: customSource,
			targetProviderThreadId: "pi_durable_custom_forked",
			env,
		});

		const forkedDbPath = join(tempDir, "pi_durable_custom_forked", "session.sqlite");
		assert.deepEqual(getEntryIds(forkedDbPath), [10]);
	});

	it("Bridge RPC thread/fork handles fork request and returns new providerThreadId", async () => {
		const originalSessionDir = process.env.BB_PI_BRIDGE_SESSION_DIR;
		process.env.BB_PI_BRIDGE_SESSION_DIR = tempDir;

		try {
			const responses: string[] = [];
			const mockRegistry = new MockSessionRegistry(() => {});
			const bridge = new ProviderBridge((json) => responses.push(json), mockRegistry);

			await bridge.handleLine(JSON.stringify({
				id: "fork_rpc_1",
				method: "thread/fork",
				params: {
					threadId: "thr_child_fork_rpc",
					sourceProviderThreadId: "pi_durable_parent",
					sourceProviderCheckpointId: "1",
				},
			}));

			assert.equal(responses.length, 1);
			const res = JSON.parse(responses[0]);
			assert.equal(res.id, "fork_rpc_1");
			assert.ok(typeof res.result.providerThreadId === "string");
			assert.ok(res.result.providerThreadId.startsWith("pi_durable_"));
			assert.equal(res.result.sessionRestorable, true);

			assert.equal(mockRegistry.created.length, 1);
			assert.equal(mockRegistry.created[0].threadId, "thr_child_fork_rpc");
			assert.equal(mockRegistry.created[0].providerThreadId, res.result.providerThreadId);

			const childDbPath = join(tempDir, res.result.providerThreadId, "session.sqlite");
			assert.deepEqual(getEntryIds(childDbPath), [1]);
		} finally {
			if (originalSessionDir !== undefined) process.env.BB_PI_BRIDGE_SESSION_DIR = originalSessionDir;
			else delete process.env.BB_PI_BRIDGE_SESSION_DIR;
		}
	});

	it("Bridge RPC thread/fork returns -32000 error when source thread does not exist", async () => {
		const originalSessionDir = process.env.BB_PI_BRIDGE_SESSION_DIR;
		process.env.BB_PI_BRIDGE_SESSION_DIR = tempDir;

		try {
			const responses: string[] = [];
			const mockRegistry = new MockSessionRegistry(() => {});
			const bridge = new ProviderBridge((json) => responses.push(json), mockRegistry);

			await bridge.handleLine(JSON.stringify({
				id: "fork_rpc_err",
				method: "thread/fork",
				params: { threadId: "thr_child_err", sourceProviderThreadId: "pi_durable_missing" },
			}));

			assert.equal(responses.length, 1);
			const res = JSON.parse(responses[0]);
			assert.equal(res.id, "fork_rpc_err");
			assert.equal(res.error.code, -32000);
			assert.match(res.error.message, /Cannot fork: source session database not found for "pi_durable_missing"/);
		} finally {
			if (originalSessionDir !== undefined) process.env.BB_PI_BRIDGE_SESSION_DIR = originalSessionDir;
			else delete process.env.BB_PI_BRIDGE_SESSION_DIR;
		}
	});
});
