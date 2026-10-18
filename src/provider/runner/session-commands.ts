import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { OpenDurableResult } from "./runtime.ts";
import type { CliArgs } from "./cli-args.ts";

export interface CommandResponder {
	success: (id: string | undefined, command: string, data?: unknown) => void;
	error: (id: string | undefined, command: string, message: string) => void;
}

interface SessionAgentDoc {
	model?: { provider?: string; id?: string; modelId?: string };
	thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel;
}

export interface RunnerCommandPayload {
	type?: string;
	id?: string;
	message?: string;
	streamingBehavior?: string;
	provider?: string;
	modelId?: string;
	instructions?: string;
	level?: import("@earendil-works/pi-ai").ModelThinkingLevel;
	conversationId?: string | number;
}

export function parseConversationId(id: string | number | undefined | null): import("@earendil-works/pi-durable").ConversationId {
	if (id === undefined || id === null) return ROOT_CONVERSATION_ID;
	const trimmed = typeof id === "string" ? id.trim() : id;
	if (trimmed === "") {
		throw new Error(`Invalid conversationId: ${String(id)}`);
	}
	const num = typeof trimmed === "number" ? trimmed : Number(trimmed);
	if (!Number.isInteger(num) || num <= 0) {
		throw new Error(`Invalid conversationId: ${String(id)}`);
	}
	return num as import("@earendil-works/pi-durable").ConversationId;
}

export async function handleActiveSessionCommand(
	cmd: RunnerCommandPayload,
	durable: OpenDurableResult,
	modelRuntime: ModelRuntime,
	args: CliArgs,
	respond: CommandResponder,
): Promise<void> {
	switch (cmd.type) {
		case "prompt": {
			if (!cmd.message) {
				respond.error(cmd.id, "prompt", "Missing message");
				return;
			}
			respond.success(cmd.id, "prompt");
			const behavior = (cmd.streamingBehavior as "steer" | "followUp") || "followUp";
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (!conv) {
					throw new Error(`Conversation not found: ${cmd.conversationId}`);
				}
				await conv.submit({ type: "input", content: cmd.message, whenBusy: behavior }, BACKGROUND_CONTEXT);
			} else {
				await durable.controller.submit(cmd.message, behavior);
			}
			break;
		}
		case "steer": {
			if (!cmd.message) {
				respond.error(cmd.id, "steer", "Missing message");
				return;
			}
			respond.success(cmd.id, "steer");
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (!conv) {
					throw new Error(`Conversation not found: ${cmd.conversationId}`);
				}
				await conv.submit({ type: "input", content: cmd.message, whenBusy: "steer" }, BACKGROUND_CONTEXT);
			} else {
				await durable.controller.submit(cmd.message, "steer");
			}
			break;
		}
		case "abort": {
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (conv) {
					await conv.abort(BACKGROUND_CONTEXT);
				}
			} else {
				await durable.controller.abort();
			}
			respond.success(cmd.id, "abort");
			break;
		}
		case "compact": {
			await durable.controller.compact(cmd.instructions);
			respond.success(cmd.id, "compact");
			break;
		}
		case "get_state": {
			const current = durable.view.current();
			const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as SessionAgentDoc;
			const modelObj = agentDoc.model
				? {
						provider: agentDoc.model.provider,
						id: agentDoc.model.id ?? agentDoc.model.modelId,
						modelId: agentDoc.model.modelId ?? agentDoc.model.id,
					}
				: null;
			respond.success(cmd.id, "get_state", {
				model: modelObj,
				thinkingLevel: agentDoc.thinkingLevel ?? "none",
				cwd: args.cwd ?? process.cwd(),
				sessionId: args.session ?? "default",
			});
			break;
		}
		case "get_available_models": {
			const currentModels = modelRuntime.getAvailableSnapshot();
			respond.success(cmd.id, "get_available_models", { models: currentModels });
			break;
		}
		case "set_model": {
			if (!cmd.provider || !cmd.modelId) {
				respond.error(cmd.id, "set_model", "Missing provider or modelId");
				return;
			}
			await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
			respond.success(cmd.id, "set_model");
			break;
		}
		case "set_thinking_level": {
			if (!cmd.level) {
				respond.error(cmd.id, "set_thinking_level", "Missing thinking level");
				return;
			}
			await durable.controller.setThinkingLevel(cmd.level);
			respond.success(cmd.id, "set_thinking_level");
			break;
		}
		case "get_session_stats": {
			const current = durable.view.current();
			const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as SessionAgentDoc;
			let contextWindow = 128000;
			const provider = agentDoc.model?.provider ?? args.provider;
			const modelId = agentDoc.model?.modelId ?? args.model;
			if (provider && modelId) {
				const m = modelRuntime.getModel(provider, modelId);
				if (m?.contextWindow) contextWindow = m.contextWindow;
			}
			let tokens: number | null = null;
			try {
				const conv = await durable.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
				if (conv) {
					const ctxView = await conv.context(BACKGROUND_CONTEXT);
					const estimate = estimateContextTokens(ctxView.messages);
					tokens = estimate.tokens;
				}
			} catch (err) {
				console.error(`Error estimating context tokens: ${err}`);
			}
			respond.success(cmd.id, "get_session_stats", {
				contextUsage: {
					tokens,
					contextWindow,
				},
			});
			break;
		}
		default: {
			respond.error(cmd.id, cmd.type ?? "unknown", `Unknown command: ${cmd.type}`);
			break;
		}
	}
}
