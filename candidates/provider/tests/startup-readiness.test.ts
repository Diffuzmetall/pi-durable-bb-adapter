import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiThreadSession } from "../src/host/session.ts";
import { ModelCatalog } from "../src/host/catalog.ts";

// A real runner enumerates every configured provider before it announces ready: 12.1s measured on a machine with
// many of them, so this is a fail-fast ceiling (`Issue #3`), not a speed assertion.
const CATALOGUE_READY_BUDGET_MS = 45_000;

describe("Startup Readiness & Fail-Fast Handshake (Issue #3)", () => {
	it("PiThreadSession.start() rejects immediately and kills runner when runner exits before ready", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-1.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_exit",
			},
			() => {},
		);

		try {
			// Simulate child exiting immediately before ready
			session.runner.kill();
			(session.runner as any).options.onExit?.(1, null);

			await assert.rejects(
				async () => session.start(),
				(err: Error) => {
					assert.ok(err.message.includes("Runner exited before becoming ready") || err.message.includes("timed out"));
					return true;
				},
			);
			assert.equal(session.runner.exited, true, "runner must be marked exited when start() rejects");
		} finally {
			session.runner.kill();
		}
	});

	it("PiThreadSession.start() rejects and kills runner when initial context refresh RPC fails", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-2.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_rpc",
			},
			() => {},
		);

		try {
			// Deliver ready
			(session.runner as any).options.onChannelMessage?.({ kind: "ready" });

			// Stub request to fail on get_state
			session.runner.request = async () => {
				throw new Error("RPC get_state connection reset (injected)");
			};

			await assert.rejects(
				async () => session.start(),
				(err: Error) => {
					assert.ok(err.message.includes("RPC get_state connection reset"));
					return true;
				},
			);
			assert.equal(session.runner.exited, true, "runner must be killed when refreshContextUsage fails");
		} finally {
			session.runner.kill();
		}
	});

	it("PiThreadSession.start() clears timeout timer upon successful ready", async () => {
		let clearedTimer: any = null;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.clearTimeout = ((t: any) => {
			clearedTimer = t;
			originalClearTimeout(t);
		}) as any;

		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-3.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_timer",
			},
			() => {},
		);

		try {
			// Deliver ready
			(session.runner as any).options.onChannelMessage?.({ kind: "ready" });
			session.runner.request = async () => ({
				contextUsage: { tokens: 100, contextWindow: 200000 },
			});

			await session.start();
			assert.ok(clearedTimer !== null, "timeout timer must be explicitly cleared on success");
		} finally {
			globalThis.clearTimeout = originalClearTimeout;
			session.runner.kill();
		}
	});

	it("ModelCatalog.start() rejects immediately and cleans up when runner exits before ready", async () => {
		const catalog = new ModelCatalog();
		try {
			const startPromise = catalog.start();
			const runner = (catalog as any).runner;
			assert.ok(runner, "runner should have been created");
			runner.kill();
			runner.options.onExit?.(1, null);

			await assert.rejects(
				async () => startPromise,
				(err: Error) => {
					assert.ok(err.message.includes("Catalog runner exited before becoming ready") || err.message.includes("timed out"));
					return true;
				},
			);
			assert.equal((catalog as any).runner, null, "runner must be cleaned up and set to null on startup failure");
		} finally {
			catalog.close();
		}
	});

	it("ModelCatalog.start() clears timeout timer on successful ready", async () => {
		let clearedTimer: any = null;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.clearTimeout = ((t: any) => {
			clearedTimer = t;
			originalClearTimeout(t);
		}) as any;

		const catalog = new ModelCatalog();
		try {
			const startPromise = catalog.start();
			const runner = (catalog as any).runner;
			runner.options.onChannelMessage?.({ kind: "ready" });

			await startPromise;
			assert.ok(clearedTimer !== null, "catalog startup timeout timer must be cleared");
		} finally {
			globalThis.clearTimeout = originalClearTimeout;
			catalog.close();
		}
	});

	it("Runner announces ready in catalogue probe mode (--no-session)", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-4.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_cat",
				noSession: true,
			},
			() => {},
		);

		let receivedReady = false;
		session.readyPromise.then(() => {
			receivedReady = true;
		});

		let timer: NodeJS.Timeout | undefined;
		try {
			// Runner in --no-session will execute models discovery and emit ready over FD 3
			await Promise.race([
				session.readyPromise,
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Catalogue ready timed out after ${CATALOGUE_READY_BUDGET_MS}ms`)),
						CATALOGUE_READY_BUDGET_MS,
					);
				}),
			]);
			assert.equal(receivedReady, true, "Catalogue mode must become ready without opening SQLite session");
		} finally {
			clearTimeout(timer);
			session.runner.kill();
		}
	});
});
