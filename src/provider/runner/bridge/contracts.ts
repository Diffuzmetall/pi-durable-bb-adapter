/**
 * Wire contracts and DTO schemas for Beyond Boundaries (BB IDE) RPC integration.
 * In accordance with AP-026 (DTO boundaries & strict schema validation) and AP-029 (Zero any casts).
 */

export interface BBToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string | number;
	toolName: string;
	args: Record<string, unknown>;
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string | number;
	toolName: string;
	partialResult: string;
	trimStart?: number;
	details?: unknown;
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string | number;
	toolName: string;
	result: string;
	isError: boolean;
	details?: unknown;
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBThinkingDeltaEvent {
	type: "message_update";
	assistantMessageEvent: { type: "thinking_delta"; contentIndex: 0; delta: string };
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBThinkingEndEvent {
	type: "message_update";
	assistantMessageEvent: { type: "thinking_end"; contentIndex: 0; content: string };
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBTextDeltaEvent {
	type: "message_update";
	assistantMessageEvent: { type: "text_delta"; contentIndex: number; delta: string };
	parentRef?: string;
	conversationId?: string | number;
}

export type BBMessageUpdateEvent = BBThinkingDeltaEvent | BBThinkingEndEvent | BBTextDeltaEvent;

export interface BBAssistantMessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface BBAssistantMessage {
	role: "assistant";
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>;
	stopReason?: "stop" | "toolUse" | "length" | "aborted" | "error";
	usage?: BBAssistantMessageUsage;
}

export interface BBAgentStartEvent { type: "agent_start"; }
export interface BBTurnStartEvent { type: "turn_start"; }

export interface CumulativeUsageMetrics {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
}

export interface BBTurnEndEvent {
	type: "turn_end";
	message?: BBAssistantMessage;
	contextWindow?: number;
	providerCheckpointId?: string;
	cumulativeUsage?: CumulativeUsageMetrics;
	aborted?: boolean;
	stopReason?: string;
}

export interface BBMessageEndEvent {
	type: "message_end";
	message: BBAssistantMessage;
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBAgentEndEvent {
	type: "agent_end";
	messages: BBAssistantMessage[];
	providerCheckpointId?: string;
	contextWindow?: number;
	cumulativeUsage?: CumulativeUsageMetrics;
	aborted?: boolean;
	stopReason?: string;
	parentRef?: string;
	conversationId?: string | number;
}

export interface BBCompactionStartEvent {
	type: "compaction_start";
	reason: "manual" | "threshold";
}

export interface BBCompactionEndEvent {
	type: "compaction_end";
	reason: "manual" | "threshold";
	aborted: boolean;
}

export interface BBAutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	at?: number;
	errorMessage?: string;
}

export interface BBAutoRetryEndEvent {
	type: "auto_retry_end";
	attempt: number;
	success?: boolean;
}

/** One row of BB's plan panel. BB renders these flat, so hierarchy lives in the label text. */
export interface BBPlanStep {
	step: string;
	status: "pending" | "active" | "completed" | "failed";
}

export interface BBTasksSnapshotEvent {
	type: "tasks_snapshot";
	steps: BBPlanStep[];
}

export interface BBSessionStatsData {
	contextUsage: { tokens: number; contextWindow: number };
}

export type BBWireEvent =
	| BBAgentStartEvent
	| BBTurnStartEvent
	| BBMessageUpdateEvent
	| BBToolExecutionStartEvent
	| BBToolExecutionUpdateEvent
	| BBToolExecutionEndEvent
	| BBMessageEndEvent
	| BBTurnEndEvent
	| BBAgentEndEvent
	| BBCompactionStartEvent
	| BBCompactionEndEvent
	| BBAutoRetryStartEvent
	| BBAutoRetryEndEvent
	| BBTasksSnapshotEvent;

// Durable SQLite Document Schemas & Type Guards (AP-026, AP-029)
export * from "./durable-contracts.ts";
