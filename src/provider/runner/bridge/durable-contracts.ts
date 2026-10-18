/**
 * Durable SQLite Document Schemas & Type Guards (AP-026, AP-029).
 */

export interface AgentDocument {
	model?: { provider?: string; modelId?: string };
}

export interface UsageDocument {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	models?: Record<string, unknown>;
	tools?: Record<string, unknown>;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	[key: string]: unknown;
}

export interface ToolArgumentsDocument {
	[key: string]: unknown;
}

export interface ToolCallBlock {
	type: string;
	id?: string;
	callId?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export type ConversationEntryRecord = import("@earendil-works/pi-durable").EntryRecord;

export interface LiveToolSlotRecord {
	id?: string | number;
	callId?: string;
	args?: Record<string, unknown>;
	[key: string]: unknown;
}

export function isAgentDocument(doc: unknown): doc is AgentDocument {
	return typeof doc === "object" && doc !== null;
}

export function isUsageDocument(doc: unknown): doc is UsageDocument {
	return typeof doc === "object" && doc !== null;
}

export function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null && (block as ToolCallBlock).type === "toolCall";
}

export function isConversationEntryRecord(entry: unknown): entry is ConversationEntryRecord {
	return typeof entry === "object" && entry !== null;
}
