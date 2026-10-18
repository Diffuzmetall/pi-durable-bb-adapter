import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DurableView } from "../runtime.ts";
import {
	isUsageDocument,
	isConversationEntryRecord,
	type BBAssistantMessage,
	type BBAssistantMessageUsage,
	type ConversationEntryRecord,
	type CumulativeUsageMetrics,
	type UsageDocument,
} from "./contracts.ts";

interface TokenUsageBucket {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	[key: string]: unknown;
}

/**
 * Extracts and aggregates cumulative token usage metrics across models and tools in `pi.usage`.
 * Strictly monotonic per AP-013 and AP-026.
 */
export function extractCumulativeUsage(current: DurableView): CumulativeUsageMetrics | undefined {
	const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
	if (!rawUsageDoc || typeof rawUsageDoc !== "object") {
		return undefined;
	}

	const usageDoc = rawUsageDoc as {
		models?: Record<string, TokenUsageBucket>;
		tools?: Record<string, TokenUsageBucket>;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};

	let totalTokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let cacheWriteInputTokens = 0;
	let hasUsage = false;

	const accumulate = (entry?: TokenUsageBucket) => {
		if (!entry || typeof entry !== "object") return;
		const inTok = Number(entry.input ?? 0);
		const outTok = Number(entry.output ?? 0);
		const totTok = Number(entry.totalTokens ?? (inTok + outTok));
		const cacheRead = Number(entry.cacheRead ?? 0);
		const cacheWrite = Number(entry.cacheWrite ?? 0);

		if (totTok > 0 || inTok > 0 || outTok > 0 || cacheRead > 0 || cacheWrite > 0) {
			hasUsage = true;
			totalTokens += totTok;
			inputTokens += inTok;
			outputTokens += outTok;
			cachedInputTokens += cacheRead;
			cacheWriteInputTokens += cacheWrite;
		}
	};

	if (usageDoc.models && typeof usageDoc.models === "object") {
		for (const modelUsage of Object.values(usageDoc.models)) {
			accumulate(modelUsage);
		}
	}

	if (usageDoc.tools && typeof usageDoc.tools === "object") {
		for (const toolUsage of Object.values(usageDoc.tools)) {
			accumulate(toolUsage);
		}
	}

	// Fallback if models and tools are empty or absent but flat properties exist
	if (!hasUsage && (usageDoc.totalTokens != null || usageDoc.input != null || usageDoc.output != null)) {
		accumulate(usageDoc);
	}

	if (!hasUsage && totalTokens === 0) {
		return undefined;
	}

	return {
		totalTokens,
		inputTokens,
		outputTokens,
		...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
		...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
	};
}

/**
 * Reconstructs or extracts the final assistant message and usage metrics for turn completion.
 * AP-026, AP-029 compliant.
 */
export function buildFinalAssistantMessage(
	current: DurableView,
	lastGenerationText: string,
	lastThinkingText: string,
): BBAssistantMessage {
	const entries = current.conversation.entries ?? [];
	const lastAssistantEntry = [...entries].reverse().find(
		(e): e is ConversationEntryRecord => isConversationEntryRecord(e) && e.kind === "pi.assistant",
	);
	const lastAssistantMsg = lastAssistantEntry?.model?.[0] as AssistantMessage | undefined;

	if (lastAssistantMsg) {
		const content = Array.isArray(lastAssistantMsg.content)
			? (lastAssistantMsg.content as unknown as BBAssistantMessage["content"])
			: [{ type: "text" as const, text: lastGenerationText }];
		const stopReason = typeof lastAssistantMsg.stopReason === "string"
			? (lastAssistantMsg.stopReason as BBAssistantMessage["stopReason"])
			: "stop";
		const usage = (typeof lastAssistantMsg.usage === "object" && lastAssistantMsg.usage !== null)
			? (lastAssistantMsg.usage as BBAssistantMessageUsage)
			: undefined;

		return {
			role: "assistant",
			content,
			stopReason,
			usage,
		};
	}

	const finalContent: BBAssistantMessage["content"] = [];
	if (lastThinkingText) {
		finalContent.push({ type: "thinking", thinking: lastThinkingText });
	}
	if (lastGenerationText) {
		finalContent.push({ type: "text", text: lastGenerationText });
	}

	const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
	const usageDoc: UsageDocument = isUsageDocument(rawUsageDoc) ? rawUsageDoc : {};
	const cumUsage = extractCumulativeUsage(current);

	const inTok = cumUsage?.inputTokens ?? usageDoc.input;
	const outTok = cumUsage?.outputTokens ?? usageDoc.output;
	const cacheRead = cumUsage?.cachedInputTokens ?? usageDoc.cacheRead;
	const cacheWrite = cumUsage?.cacheWriteInputTokens ?? usageDoc.cacheWrite;
	const totalTokens = cumUsage?.totalTokens ?? usageDoc.totalTokens ?? ((inTok ?? 0) + (outTok ?? 0));

	return {
		role: "assistant",
		content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
		stopReason: "stop",
		usage: {
			input: inTok,
			output: outTok,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: usageDoc.cost,
		},
	};
}
