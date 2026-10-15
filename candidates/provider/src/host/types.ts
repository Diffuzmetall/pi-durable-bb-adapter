import { z } from "zod";

export const PROVIDER_ID = "pi-durable";
export const PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
export const THREAD_DELTA_GRAMMAR_V2 = 2;
export const THREAD_DELTA_GRAMMAR_V3 = 3;

export interface AvailableModelDescriptor {
	id: string;
	model: string;
	displayName: string;
	routeProviderId: string;
	description?: string;
	supportedReasoningEfforts?: Array<{
		reasoningEffort: string;
		description: string;
	}>;
	defaultReasoningEffort?: string;
	isDefault?: boolean;
}

export interface ModelScope {
	scopedModelIds?: string[];
	defaultModelId?: string;
}

export interface ContextWindowUsage {
	tokens: number | null;
	contextWindow: number;
}

export interface ToolCallForwardResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
}

export interface SessionOptions {
	threadId: string;
	providerThreadId: string;
	cwd?: string;
	sessionFilePath: string;
	sessionDir: string;
	extensionPath: string;
	scratchDir: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	shellEnvOverrides?: Record<string, string>;
	additionalSkillPaths?: string[];
	dynamicTools?: unknown[];
	noSession?: boolean;
	onExtensionUiRequest?: (request: unknown) => void;
	providerOptions?: Record<string, unknown>;
}

export interface CumulativeUsageMetrics {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
}

export interface RunnerEvent {
	type: string;
	providerCheckpointId?: string;
	cumulativeUsage?: CumulativeUsageMetrics;
	aborted?: boolean;
	stopReason?: string;
	[key: string]: unknown;
}

export interface ThreadDelta {
	kind: string;
	[key: string]: unknown;
}

export interface PiThreadSessionEntry {
	threadId: string;
	providerThreadId: string;
	cwd?: string;
	session: unknown;
	sessionSerial: number;
	closing: boolean;
	construction: SessionOptions;
	constructionModel?: { provider: string; id: string };
}

export const promptInputSchema = z
	.array(
		z.discriminatedUnion("type", [
			z.object({
				type: z.literal("text"),
				text: z.string(),
				mentions: z
					.array(
						z.object({
							start: z.number(),
							end: z.number(),
							resource: z.object({
								kind: z.string(),
								source: z.string().optional(),
								trigger: z.string().optional(),
								name: z.string().optional(),
							}),
						}),
					)
					.default([]),
			}),
			z.object({
				type: z.literal("localImage"),
				path: z.string(),
			}),
			z.object({
				type: z.literal("localFile"),
				path: z.string(),
			}),
		]),
	)
	.default([]);

export type PromptInput = z.infer<typeof promptInputSchema>;
