import type { DurableView } from "../runtime.ts";
import {
	isAgentDocument,
	isConversationEntryRecord,
	type AgentDocument,
	type ConversationEntryRecord,
	type BBAssistantMessage,
	type CumulativeUsageMetrics,
} from "./contracts.ts";
import {
	buildFinalAssistantMessage,
	extractCumulativeUsage,
} from "./assistant-message-builder.ts";

export interface TurnSummaryResult {
	finalMsg: BBAssistantMessage;
	cw?: number;
	cumulativeUsage?: CumulativeUsageMetrics;
	isAborted: boolean;
	lastCheckpointId?: string;
}

export function resolveTurnSummary(
	current: DurableView,
	currentText: string,
	currentThinking: string,
	lastAssistantMessage?: BBAssistantMessage,
	resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined,
): TurnSummaryResult {
	const tail = current?.conversation?.entries?.at(-1);
	const lastCheckpointId = tail?.id !== undefined ? String(tail.id) : undefined;

	const finalMsg = lastAssistantMessage ?? buildFinalAssistantMessage(
		current,
		currentText,
		currentThinking,
	);
	const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
	const agentDoc: AgentDocument = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
	const cw = resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
	const cumulativeUsage = extractCumulativeUsage(current);

	const entries = current?.conversation?.entries ?? [];
	const lastAssistantEntry = [...entries].reverse().find(
		(e): e is ConversationEntryRecord => isConversationEntryRecord(e) && e.kind === "pi.assistant",
	);
	const firstModelMsg = lastAssistantEntry?.model?.[0];
	const isLastAssistantAborted = Boolean(
		firstModelMsg && "stopReason" in firstModelMsg && (firstModelMsg as { stopReason?: string }).stopReason === "aborted",
	);
	const isAborted = finalMsg.stopReason === "aborted" || isLastAssistantAborted;

	if (isAborted && finalMsg.stopReason !== "aborted") {
		finalMsg.stopReason = "aborted";
	}

	return { finalMsg, cw, cumulativeUsage, isAborted, lastCheckpointId };
}
