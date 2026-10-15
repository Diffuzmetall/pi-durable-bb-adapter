import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { agentOf, type OpenDurableResult } from "./runtime.ts";

export interface SharedCommand { id?: string; type: string; [key: string]: unknown }

export async function sharedCommand(host: OpenDurableResult, cmd: SharedCommand) {
	const id = cmd.conversationId === undefined ? ROOT_CONVERSATION_ID : Number(cmd.conversationId);
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid conversationId");
	const conversation = await host.harness.conversation(id as ConversationId, context);
	if (!conversation) throw new Error(`Conversation ${id} does not exist`);
	switch (cmd.type) {
		case "get_available_models": return { models: host.modelRuntime.getAvailableSnapshot() };
		case "get_state": {
			const agent = await conversation.agent(context);
			return { model: agent.model ? { ...agent.model, id: agent.model.modelId } : null,
				thinkingLevel: agent.thinkingLevel ?? "off", cwd: host.view.current().session.cwd,
				sessionId: host.view.current().session.id };
		}
		case "prompt": case "steer": {
			if (typeof cmd.message !== "string" || !cmd.message.trim()) throw new Error("Missing message");
			if (cmd.streamingBehavior !== undefined && !["steer", "followUp"].includes(String(cmd.streamingBehavior)))
				throw new Error("Invalid streamingBehavior");
			await host.submitTo(id as ConversationId, cmd.message,
				cmd.type === "steer" || cmd.streamingBehavior === "steer" ? "steer" : "followUp");
			return {};
		}
		case "abort": await conversation.abort(context); return {};
		case "compact": {
			if (cmd.instructions !== undefined && typeof cmd.instructions !== "string") throw new Error("Invalid instructions");
			await conversation.compact(cmd.instructions as string | undefined, context); return {};
		}
		case "set_model": {
			if (typeof cmd.provider !== "string" || typeof cmd.modelId !== "string") throw new Error("Missing provider or modelId");
			const model = host.modelRuntime.getModel(cmd.provider, cmd.modelId);
			if (!model) throw new Error("Unknown model");
			const agent = await conversation.agent(context);
			await conversation.configure({ model: { provider: cmd.provider, modelId: cmd.modelId },
				thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel ?? "off") }, context);
			return {};
		}
		case "set_thinking_level": {
			const agent = await conversation.agent(context);
			const model = agent.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId);
			const level = cmd.level === "none" ? "off" : cmd.level;
			if (!model || typeof level !== "string" || !getSupportedThinkingLevels(model).includes(level as never))
				throw new Error("Unsupported thinking level");
			await conversation.configure({ thinkingLevel: level as never }, context); return {};
		}
		case "get_session_stats": {
			const agent = await conversation.agent(context);
			const model = agent.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId);
			return { contextUsage: { tokens: null, contextWindow: model?.contextWindow ?? null } };
		}
		default: throw new Error(`Unsupported shared-host command: ${cmd.type}`);
	}
}
