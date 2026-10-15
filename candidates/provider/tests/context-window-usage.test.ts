import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunnerProcess } from "../src/host/runner-process.ts";
import { PiThreadSession } from "../src/host/session.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Context Window Telemetry & Usage Synchronization (Cycle 57)", () => {
	it("RunnerProcess.requestOk unwraps data payload and rejects on success: false", async () => {
		const runner = new RunnerProcess({
			cwd: process.cwd(),
			args: ["--mode", "rpc", "--no-session"],
		});

		try {
			// Mock incoming message with data payload
			(runner as any).handleIncoming({
				id: "req_test_1",
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {
					contextUsage: { tokens: 45000, contextWindow: 1048576 },
				},
			});

			// If request resolves via handleIncoming
			const mockPending = (runner as any).pendingRequests;
			mockPending.set("req_100", {
				resolve: (val: any) => val,
				reject: (err: any) => { throw err; },
			});

			(runner as any).handleIncoming({
				id: "req_100",
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {
					contextUsage: { tokens: 42000, contextWindow: 1048576 },
				},
			});

			// Direct verification of requestOk unwrapping behavior
			(runner as any).request = async () => ({
				id: "req_200",
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {
					contextUsage: { tokens: 42000, contextWindow: 1048576 },
				},
			});

			const unwrapped = await runner.requestOk({ type: "get_session_stats" });
			assert.deepEqual(unwrapped, {
				contextUsage: { tokens: 42000, contextWindow: 1048576 },
			});

			// Verification that success: false rejects
			(runner as any).request = async () => ({
				id: "req_201",
				type: "response",
				command: "test_fail",
				success: false,
				error: "Failed to estimate tokens",
			});

			await assert.rejects(
				async () => runner.requestOk({ type: "test_fail" }),
				(err: Error) => {
					assert.equal(err.message, "Failed to estimate tokens");
					return true;
				},
			);
		} finally {
			runner.kill();
		}
	});

	it("PiThreadSession.getSessionStats extracts contextUsage from wrapped or unwrapped responses", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-stats.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_stats",
			},
			() => {},
		);

		try {
			// Case 1: Wrapped inside data (actual wire format)
			session.runner.requestOk = async () => ({
				data: {
					contextUsage: { tokens: 35000, contextWindow: 1048576 },
				},
			});
			const stats1 = await session.getSessionStats();
			assert.equal(stats1.tokens, 35000);
			assert.equal(stats1.contextWindow, 1048576);

			// Case 2: Unwrapped contextUsage top-level
			session.runner.requestOk = async () => ({
				contextUsage: { tokens: 45300, contextWindow: 1048576 },
			});
			const stats2 = await session.getSessionStats();
			assert.equal(stats2.tokens, 45300);
			assert.equal(stats2.contextWindow, 1048576);

			// Case 3: Empty / missing returns safe fallback
			session.runner.requestOk = async () => ({});
			const stats3 = await session.getSessionStats();
			assert.equal(stats3.tokens, null);
			assert.equal(stats3.contextWindow, 0);
		} finally {
			session.runner.kill();
		}
	});

	it("PiThreadSession.refreshContextUsage sends contextWindow delta with correct tokens and size", async () => {
		const notifications: Array<{ method: string; params: any }> = [];
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-refresh.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_refresh",
			},
			(method, params) => notifications.push({ method, params }),
		);

		try {
			session.runner.requestOk = async () => ({
				data: {
					contextUsage: { tokens: 45300, contextWindow: 1048576 },
				},
			});

			await session.refreshContextUsage();

			assert.equal(notifications.length, 1);
			assert.equal(notifications[0].method, "thread/delta");
			assert.equal(notifications[0].params.threadId, "thr_test_refresh");
			assert.deepEqual(notifications[0].params.deltas, [
				{
					kind: "contextWindow",
					used: 45300,
					size: 1048576,
					estimated: true,
					attach: "currentOrLast",
				},
			]);
		} finally {
			session.runner.kill();
		}
	});

	it("handleRunnerEvent('agent_end') refreshes context usage before finalizing the turn", async () => {
		const eventOrder: string[] = [];
		const notifications: Array<{ method: string; params: any }> = [];

		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: join(tmpdir(), `session-${Date.now()}-order.sqlite`),
				sessionDir: tmpdir(),
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_order",
			},
			(method, params) => {
				notifications.push({ method, params });
				const firstDelta = params?.deltas?.[0]?.kind;
				if (firstDelta) {
					eventOrder.push(firstDelta);
				}
			},
		);

		try {
			session.runner.requestOk = async () => {
				eventOrder.push("refresh_rpc");
				return {
					data: {
						contextUsage: { tokens: 12500, contextWindow: 200000 },
					},
				};
			};

			// Emit agent_start then agent_end
			await (session as any).handleRunnerEvent({ type: "agent_start" });
			await (session as any).handleRunnerEvent({
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { input: 12000, output: 500 },
					},
				],
			});

			// contextWindow must precede turn.boundary
			const cwIndex = eventOrder.indexOf("contextWindow");
			const boundaryIndex = eventOrder.indexOf("usage"); // usage/turn.boundary from agent_end
			assert.ok(cwIndex !== -1, "contextWindow delta must have been emitted");
			assert.ok(boundaryIndex !== -1, "agent_end deltas must have been emitted");
			assert.ok(cwIndex < boundaryIndex, `contextWindow (index ${cwIndex}) must be emitted before agent_end deltas (index ${boundaryIndex})`);
		} finally {
			session.runner.kill();
		}
	});

	it("BBEventAdapter propagates contextWindow on turn_end and run_end when resolver is provided", () => {
		const emitted: BBWireEvent[] = [];
		const contextWindowResolver = (provider?: string, modelId?: string) => {
			if (provider === "antigravity" && modelId === "gemini-3.8-flash") return 1048576;
			return undefined;
		};

		const adapter = new BBEventAdapter(
			(evt) => emitted.push(evt),
			contextWindowResolver,
		);

		const mockView = {
			conversation: {
				docs: {
					"pi.agent": {
						model: { provider: "antigravity", modelId: "gemini-3.8-flash" },
					},
				},
			},
		} as unknown as DurableView;

		adapter.handleEvent({ type: "run_start", inputs: [] as any }, mockView);
		adapter.handleEvent({ type: "turn_end" }, mockView);
		adapter.handleEvent({ type: "run_end" } as any, mockView);

		const turnEnd = emitted.find((e) => e.type === "turn_end");
		const agentEnd = emitted.find((e) => e.type === "agent_end");

		assert.ok(turnEnd);
		assert.equal((turnEnd as any).contextWindow, 1048576);
		assert.ok(agentEnd);
		assert.equal((agentEnd as any).contextWindow, 1048576);
	});

	it("DeltaTranslator maps event.contextWindow into usage deltas", () => {
		const translator = new DeltaTranslator();
		const ctx = { threadId: "thr_test_trans" };

		translator.translate({ type: "agent_start" }, ctx);
		const deltas = translator.translate(
			{
				type: "agent_end",
				contextWindow: 1048576,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1000, output: 50 },
				},
			},
			ctx,
		);

		const usageDelta = deltas.find((d) => d.kind === "usage") as any;
		assert.ok(usageDelta);
		assert.equal(usageDelta.modelContextWindow, 1048576);

		const cwDelta = deltas.find((d) => d.kind === "contextWindow") as any;
		assert.ok(cwDelta, "contextWindow delta must be emitted synchronously on agent_end");
		assert.equal(cwDelta.used, 1050);
		assert.equal(cwDelta.size, 1048576);
		assert.equal(cwDelta.attach, "currentOrLast");
	});
});
