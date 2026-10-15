import {
	type AgentEvent,
	type AgentEventStream,
	type ConversationId,
	type Harness,
	ROOT_CONVERSATION_ID,
	watchEvents,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBChildEventAdapter } from "./bridge/bb-child-event-adapter.ts";
import type { DurableView } from "./runtime.ts";

export interface SubagentWatcherController {
	close: () => void;
}

function extractChildConversationId(event: AgentEvent): ConversationId | undefined {
	if (event.type === "tool_execution_update") {
		const details = event.details as { conversationId?: ConversationId } | undefined;
		return details?.conversationId;
	}
	if (event.type === "tool_execution_end") {
		const entryData = typeof event.entry === "object" && event.entry !== null && "data" in event.entry
			? (event.entry as { data?: { conversationId?: ConversationId } }).data
			: undefined;
		return entryData?.conversationId;
	}
	return undefined;
}

/**
 * Multiplexes native pi-durable conversation event streams into the BB event adapter.
 * Automatically discovers subagent conversations via tool execution details and
 * streams their inner reasoning and tool executions in-place under parent delegation cards.
 */
export async function startSubagentWatcher(
	harness: Harness,
	adapter: BBEventAdapter,
	getCurrentView: () => DurableView,
): Promise<SubagentWatcherController> {
	const attached = new Set<ConversationId>();
	const activeStreams = new Map<ConversationId, AgentEventStream>();

	const attach = async (conversationId: ConversationId, parentCallId?: string): Promise<void> => {
		if (attached.has(conversationId)) return;
		attached.add(conversationId);

		const isChild = parentCallId !== undefined;
		const childAdapter: BBChildEventAdapter | undefined = isChild
			? adapter.createChildAdapter(parentCallId, conversationId)
			: undefined;

		try {
			const stream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT);
			activeStreams.set(conversationId, stream);

			stream.start(async (batch: readonly AgentEvent[]) => {
				try {
					const view = getCurrentView();
					for (const event of batch) {
						if (childAdapter) {
							childAdapter.handleEvent(event, view);
						} else {
							adapter.handleEvent(event, view);
						}

						const childId = extractChildConversationId(event);
						if (childId !== undefined && !attached.has(childId)) {
							const callId = "toolCallId" in event
								? (isChild ? `${parentCallId}:${String(event.toolCallId)}` : String(event.toolCallId))
								: (parentCallId ?? "subagent");
							void attach(childId, callId);
						}
					}
				} catch (err) {
					console.error(`[SubagentWatcher] Batch handling error for conversation ${conversationId}:`, err);
				}
			});
		} catch (err) {
			console.error(`[SubagentWatcher] Failed to attach stream for conversation ${conversationId}:`, err);
		}
	};

	await attach(ROOT_CONVERSATION_ID);

	return {
		close: () => {
			for (const stream of activeStreams.values()) {
				try {
					stream.stop();
				} catch (err) {
					console.warn(`[SubagentWatcher] Stream stop warning: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			activeStreams.clear();
			attached.clear();
		},
	};
}
