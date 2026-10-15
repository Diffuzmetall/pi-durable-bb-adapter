import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type { BBWireEvent } from "./contracts.ts";
import {
	buildToolExecutionUpdate,
	buildToolExecutionEnd,
} from "./tool-result-extractor.ts";

/**
 * Handles agent events originating from a subagent conversation.
 * Automatically prefixes tool call IDs and decorates wire events with parentRef.
 * Suppresses root-level turn/lifecycle events so the parent turn boundaries remain intact.
 */
export class BBChildEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private readonly parentRef: string;
	private readonly conversationId?: string | number;
	private currentText = "";
	private currentThinking = "";
	private isInThinking = false;

	constructor(output: (event: BBWireEvent) => void, parentRef: string, conversationId?: string | number) {
		this.output = output;
		this.parentRef = parentRef;
		this.conversationId = conversationId;
	}

	private closeThinkingIfNeeded(): void {
		if (!this.isInThinking) return;
		this.isInThinking = false;
		this.output({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking },
			parentRef: this.parentRef,
			...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
		});
	}

	public handleEvent(event: AgentEvent, _current?: DurableView): void {
		switch (event.type) {
			case "message_update": {
				for (const change of event.changes) {
					if (change.type === "thinking_delta") {
						this.isInThinking = true;
						this.currentThinking += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta },
							parentRef: this.parentRef,
							...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
						});
					} else if (change.type === "text_delta") {
						this.closeThinkingIfNeeded();
						this.currentText += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta },
							parentRef: this.parentRef,
							...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
						});
					}
				}
				break;
			}

			case "tool_execution_start": {
				this.closeThinkingIfNeeded();
				this.output({
					type: "tool_execution_start",
					toolCallId: `${this.parentRef}:${event.toolCallId}`,
					toolName: event.toolName,
					args: event.args ?? {},
					parentRef: this.parentRef,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}

			case "tool_execution_update": {
				const update = buildToolExecutionUpdate(
					{ ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
					this.parentRef,
				);
				if (update) {
					this.output({
						...update,
						...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
					});
				}
				break;
			}

			case "tool_execution_end": {
				const end = buildToolExecutionEnd(
					{ ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
					this.parentRef,
				);
				this.output({
					...end,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}

			case "message_end": {
				this.closeThinkingIfNeeded();
				const message = event.entry?.model?.[0];
				if (message?.role === "assistant") {
					const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
					const delta = text.startsWith(this.currentText) ? text.slice(this.currentText.length) : text;
					if (delta) this.output({ type: "message_update",
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta }, parentRef: this.parentRef,
						...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}) });
					this.currentText = "";
					this.currentThinking = "";
				}
				break;
			}

			case "run_end": {
				this.closeThinkingIfNeeded();
				this.output({
					type: "agent_end",
					messages: [],
					parentRef: this.parentRef,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}

			// Subagent lifecycle events are scoped to the child task and must not break parent turn
			case "message_start":
			case "run_start":
			case "turn_start":
			case "turn_end":
			case "snapshot":
			case "compaction_start":
			case "compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
			default:
				break;
		}
	}
}
