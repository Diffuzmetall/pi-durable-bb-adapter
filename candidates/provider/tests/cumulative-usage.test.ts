import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { extractCumulativeUsage } from "../src/runner/bridge/assistant-message-builder.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { translateAgentEndUsage } from "../src/host/message-delta-translator.ts";
import type { BBWireEvent, CumulativeUsageMetrics } from "../src/runner/bridge/contracts.ts";

function createMockView(usageDoc?: unknown): DurableView {
	return {
		session: { id: "s1", directory: "/tmp/s1", cwd: "/tmp" },
		conversation: {
			entries: [],
			docs: usageDoc ? { "pi.usage": usageDoc } : {},
		} as unknown as DurableView["conversation"],
		conversations: [],
		models: [],
		notices: [],
	};
}

describe("Cumulative Token Usage Monotonicity & pi.usage Sync (Cycle 70, D-7)", () => {
	it("extractCumulativeUsage aggregates multiple models and tool usage from pi.usage", () => {
		const usageDoc = {
			models: {
				"openai/gpt-4o": {
					input: 100,
					output: 50,
					cacheRead: 20,
					cacheWrite: 10,
					totalTokens: 150,
				},
				"anthropic/claude-3-5": {
					input: 200,
					output: 80,
					cacheRead: 30,
					cacheWrite: 0,
					totalTokens: 280,
				},
			},
			tools: {
				web_search: {
					input: 40,
					output: 10,
					totalTokens: 50,
				},
			},
		};

		const view = createMockView(usageDoc);
		const cumulative = extractCumulativeUsage(view);

		assert.ok(cumulative !== undefined, "Expected cumulative usage to be defined");
		assert.equal(cumulative.totalTokens, 480);
		assert.equal(cumulative.inputTokens, 340);
		assert.equal(cumulative.outputTokens, 140);
		assert.equal(cumulative.cachedInputTokens, 50);
		assert.equal(cumulative.cacheWriteInputTokens, 10);
	});

	it("BBEventAdapter emits cumulativeUsage on turn_end and run_end", () => {
		const usageDoc = {
			models: {
				"test/model": {
					input: 300,
					output: 150,
					cacheRead: 40,
					cacheWrite: 15,
					totalTokens: 450,
				},
			},
		};

		const view = createMockView(usageDoc);
		const events: BBWireEvent[] = [];
		const adapter = new BBEventAdapter((evt) => events.push(evt));

		adapter.handleEvent({ type: "turn_end" } as AgentEvent, view);
		assert.equal(events.length, 1);
		const turnEnd = events[0] as Extract<BBWireEvent, { type: "turn_end" }>;
		assert.equal(turnEnd.type, "turn_end");
		assert.deepEqual(turnEnd.cumulativeUsage, {
			totalTokens: 450,
			inputTokens: 300,
			outputTokens: 150,
			cachedInputTokens: 40,
			cacheWriteInputTokens: 15,
		});

		adapter.handleEvent({ type: "run_end", inputs: [] } as unknown as AgentEvent, view);
		assert.equal(events.length, 2);
		const agentEnd = events[1] as Extract<BBWireEvent, { type: "agent_end" }>;
		assert.equal(agentEnd.type, "agent_end");
		assert.deepEqual(agentEnd.cumulativeUsage, {
			totalTokens: 450,
			inputTokens: 300,
			outputTokens: 150,
			cachedInputTokens: 40,
			cacheWriteInputTokens: 15,
		});
	});

	it("translateAgentEndUsage populates total from cumulativeUsage while preserving last", () => {
		const rawMsg = {
			usage: {
				input: 50,
				output: 20,
				cacheRead: 5,
				cacheWrite: 2,
				totalTokens: 70,
			},
		};
		const cumulativeUsage: CumulativeUsageMetrics = {
			totalTokens: 300,
			inputTokens: 200,
			outputTokens: 100,
			cachedInputTokens: 45,
			cacheWriteInputTokens: 12,
		};

		const deltas = translateAgentEndUsage(rawMsg, 128000, cumulativeUsage);
		const usageDelta = deltas.find((d) => d.kind === "usage");
		assert.ok(usageDelta !== undefined, "Expected usage delta");

		const last = usageDelta.last as Record<string, unknown>;
		const total = usageDelta.total as Record<string, unknown>;

		assert.equal(last.totalTokens, 70);
		assert.equal(last.inputTokens, 50);
		assert.equal(last.outputTokens, 20);
		assert.equal(last.cachedInputTokens, 5);

		assert.equal(total.totalTokens, 300);
		assert.equal(total.inputTokens, 200);
		assert.equal(total.outputTokens, 100);
		assert.equal(total.cachedInputTokens, 45);
		assert.equal(total.cacheWriteInputTokens, 12);
	});

	it("validates deltas against threadDeltaSchema for both cumulative and fallback modes", () => {
		const rawMsg = {
			usage: {
				input: 80,
				output: 40,
				cacheRead: 10,
				cacheWrite: 4,
				totalTokens: 120,
			},
		};
		const cumulativeUsage: CumulativeUsageMetrics = {
			totalTokens: 500,
			inputTokens: 350,
			outputTokens: 150,
			cachedInputTokens: 25,
			cacheWriteInputTokens: 8,
		};

		const deltasWithCumulative = translateAgentEndUsage(rawMsg, 128000, cumulativeUsage);
		for (const delta of deltasWithCumulative) {
			const parsed = threadDeltaSchema.safeParse(delta);
			assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error)}`);
		}

		const deltasFallback = translateAgentEndUsage(rawMsg, 128000, undefined);
		for (const delta of deltasFallback) {
			const parsed = threadDeltaSchema.safeParse(delta);
			assert.ok(parsed.success, `Fallback schema validation failed: ${JSON.stringify(parsed.error)}`);
		}
	});

	it("monotonicity: delta.total.totalTokens grows strictly across multiple turns", () => {
		const turn1Msg = { usage: { input: 100, output: 50, totalTokens: 150 } };
		const cumTurn1: CumulativeUsageMetrics = { totalTokens: 150, inputTokens: 100, outputTokens: 50 };
		const deltasTurn1 = translateAgentEndUsage(turn1Msg, 128000, cumTurn1);
		const usageTurn1 = deltasTurn1.find((d) => d.kind === "usage")!;
		const total1 = (usageTurn1.total as { totalTokens: number }).totalTokens;
		const last1 = (usageTurn1.last as { totalTokens: number }).totalTokens;

		assert.equal(last1, 150);
		assert.equal(total1, 150);

		const turn2Msg = { usage: { input: 120, output: 60, totalTokens: 180 } };
		const cumTurn2: CumulativeUsageMetrics = { totalTokens: 330, inputTokens: 220, outputTokens: 110 };
		const deltasTurn2 = translateAgentEndUsage(turn2Msg, 128000, cumTurn2);
		const usageTurn2 = deltasTurn2.find((d) => d.kind === "usage")!;
		const total2 = (usageTurn2.total as { totalTokens: number }).totalTokens;
		const last2 = (usageTurn2.last as { totalTokens: number }).totalTokens;

		assert.equal(last2, 180);
		assert.equal(total2, 330);
		assert.ok(total2 > total1, "totalTokens must monotonically grow on Turn 2");

		const turn3Msg = { usage: { input: 50, output: 25, totalTokens: 75 } };
		const cumTurn3: CumulativeUsageMetrics = { totalTokens: 405, inputTokens: 270, outputTokens: 135 };
		const deltasTurn3 = translateAgentEndUsage(turn3Msg, 128000, cumTurn3);
		const usageTurn3 = deltasTurn3.find((d) => d.kind === "usage")!;
		const total3 = (usageTurn3.total as { totalTokens: number }).totalTokens;
		const last3 = (usageTurn3.last as { totalTokens: number }).totalTokens;

		assert.equal(last3, 75);
		assert.equal(total3, 405);
		assert.ok(total3 > total2, "totalTokens must monotonically grow on Turn 3");
		assert.notEqual(last3, total3, "Turn 3 spend must not overwrite thread total spend");
	});
});
