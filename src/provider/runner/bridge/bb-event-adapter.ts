import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import {
	type BBWireEvent,
	type BBAssistantMessage,
	type BBAssistantMessageUsage,
} from "./contracts.ts";
import { resolveTurnSummary } from "./turn-summary.ts";
import {
	buildToolExecutionUpdate,
	buildToolExecutionEnd,
} from "./tool-result-extractor.ts";
import { BBChildEventAdapter } from "./bb-child-event-adapter.ts";

export { resolveToolCallArgs } from "./tool-args-resolver.ts";

interface RawAssistantEntryMessage {
	role?: string;
	content?: BBAssistantMessage["content"];
	stopReason?: BBAssistantMessage["stopReason"];
	usage?: BBAssistantMessageUsage;
	[key: string]: unknown;
}

/**
 * Transforms native @earendil-works/pi-durable AgentEvents into BB Wire JSONL events.
 * Relies directly on the first-party transactional watchEvents stream.
 */
export class BBEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private readonly resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined;
	private lastAssistantMessage?: BBAssistantMessage;
	private lastCheckpointId?: string;
	private currentText = "";
	private currentThinking = "";
	private isInThinking = false;

	constructor(output: (event: BBWireEvent) => void, resolveContextWindow?: (p?: string, m?: string) => number | undefined) {
		this.output = output;
		this.resolveContextWindow = resolveContextWindow;
	}

	private closeThinkingIfNeeded(): void {
		if (!this.isInThinking) return;
		this.isInThinking = false;
		this.output({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking } });
	}

	public createChildAdapter(parentCallId: string, conversationId?: string | number): BBChildEventAdapter {
		return new BBChildEventAdapter(this.output, parentCallId, conversationId);
	}

	private emitTerminal(type: "turn_end" | "agent_end", current: DurableView): void {
		this.closeThinkingIfNeeded();
		const summary = resolveTurnSummary(
			current,
			this.currentText,
			this.currentThinking,
			this.lastAssistantMessage,
			this.resolveContextWindow,
		);
		if (summary.lastCheckpointId) {
			this.lastCheckpointId = summary.lastCheckpointId;
		}
		const base = {
			contextWindow: summary.cw,
			...(this.lastCheckpointId ? { providerCheckpointId: this.lastCheckpointId } : {}),
			...(summary.cumulativeUsage ? { cumulativeUsage: summary.cumulativeUsage } : {}),
			...(summary.isAborted ? { aborted: true, stopReason: "aborted" } : {}),
		};
		if (type === "turn_end") {
			this.output({ type: "turn_end", message: summary.finalMsg, ...base });
		} else {
			this.output({ type: "agent_end", messages: [summary.finalMsg], ...base });
		}
	}

	public handleEvent(event: AgentEvent, current: DurableView): void {
		switch (event.type) {
			case "snapshot": {
				const snapWithView = event as SnapshotEvent & {
					view?: { conversation?: { entries?: readonly { id?: string | number }[] } };
				};
				const entries =
					snapWithView.view?.conversation?.entries ??
					event.entries ??
					current?.conversation?.entries;
				const tail = entries?.at(-1);
				if (tail?.id !== undefined) {
					this.lastCheckpointId = String(tail.id);
				}
				break;
			}

			case "run_start": {
				this.currentText = "";
				this.currentThinking = "";
				this.isInThinking = false;
				this.lastAssistantMessage = undefined;
				this.output({ type: "agent_start" });
				break;
			}

			case "turn_start": {
				this.output({ type: "turn_start" });
				break;
			}

			case "message_update": {
				for (const change of event.changes) {
					if (change.type === "thinking_delta") {
						this.isInThinking = true;
						this.currentThinking += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta },
						});
					} else if (change.type === "text_delta") {
						this.closeThinkingIfNeeded();
						this.currentText += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta },
						});
					}
				}
				break;
			}

			case "tool_execution_start": {
				this.closeThinkingIfNeeded();
				this.output({
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args ?? {},
					...(event.parentToolCallId !== undefined ? { parentRef: event.parentToolCallId } : {}),
				});
				break;
			}

			case "tool_execution_update": {
				const update = buildToolExecutionUpdate(event, event.parentToolCallId);
				if (update) this.output(update);
				break;
			}

			case "tool_execution_end": {
				this.output(buildToolExecutionEnd(event, event.parentToolCallId));
				break;
			}

			case "message_end": {
				this.closeThinkingIfNeeded();
				const modelItem = event.entry?.model?.[0];
				const msg: RawAssistantEntryMessage | undefined =
					typeof modelItem === "object" && modelItem !== null ? (modelItem as RawAssistantEntryMessage) : undefined;
				if (msg?.role === "assistant") {
					this.lastAssistantMessage = {
						role: "assistant",
						content: msg.content ?? [{ type: "text", text: this.currentText }],
						stopReason: msg.stopReason ?? "stop",
						usage: msg.usage,
					};
					this.output({ type: "message_end", message: this.lastAssistantMessage });
				}
				break;
			}

			case "compaction_start":
				this.output({ type: "compaction_start", reason: event.reason === "threshold" ? "threshold" : "manual" });
				break;
			case "compaction_end":
				this.output({ type: "compaction_end", reason: event.reason === "threshold" ? "threshold" : "manual", aborted: false });
				break;
			case "turn_end":
				this.emitTerminal("turn_end", current);
				break;
			case "run_end":
				this.emitTerminal("agent_end", current);
				break;
			case "auto_retry_start":
				this.output({
					type: "auto_retry_start",
					attempt: event.attempt,
					...(event.at !== undefined ? { at: event.at } : {}),
					...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
				});
				break;
			case "auto_retry_end":
				this.output({ type: "auto_retry_end", attempt: event.attempt });
				break;
		}
	}
}
