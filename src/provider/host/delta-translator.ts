import { experimental_planStepsPresentation as planStepsPresentation, type ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import {
	translateToolStart,
	translateToolUpdate,
	translateToolEnd,
} from "./tool-delta-translator.ts";
import {
	translateMessageUpdate,
	translateMessageEnd,
	translateAgentEnd,
} from "./message-delta-translator.ts";
import type { RunnerEvent, ThreadDelta } from "./types.ts";

/** Timeline channel of the durable task graph; stable so every snapshot closes over the same key. */
const TASKS_CHANNEL = "pi-durable-tasks";

export interface DeltaTranslatorContext {
	threadId: string;
	cwd?: string;
	clientRequestId?: string;
	providerOptions?: Record<string, unknown>;
}

export class DeltaTranslator {
	private activeTools = new Map<string, Record<string, unknown>>();
	public currentThinkingIndex = 0;
	public currentAgentText = "";
	private turnOpenSent = false;
	private turnBoundarySent = false;
	public openThinkingChannels = new Set<string>();

	public reset(): void {
		this.activeTools.clear();
		this.currentThinkingIndex = 0;
		this.currentAgentText = "";
		this.turnOpenSent = false;
		this.turnBoundarySent = false;
		this.openThinkingChannels.clear();
	}

	public translate(event: RunnerEvent, ctx: DeltaTranslatorContext): ThreadDelta[] {
		const deltas: ThreadDelta[] = [];
		const fallbackCwd = ctx.cwd || process.cwd();

		switch (event.type) {
			case "agent_start":
			case "turn_start": {
				if (!this.turnOpenSent) {
					this.turnOpenSent = true;
					deltas.push({ kind: "turn.open" });
				}
				break;
			}

			case "compaction_start": {
				const isManual = event.reason === "manual";
				if (isManual && !this.turnOpenSent) {
					this.turnOpenSent = true;
					deltas.push({ kind: "turn.open" });
				}
				deltas.push({
					kind: "item.open",
					key: { channel: "compaction" },
					item: { type: "compaction" },
					...(isManual ? {} : { attach: "currentOrLast" }),
				});
				break;
			}

			case "compaction_end": {
				deltas.push({ kind: "context.compacted" }, { kind: "turn.boundary", status: "completed" });
				this.turnOpenSent = false;
				break;
			}

			case "context_window": {
				deltas.push({
					kind: "contextWindow",
					used: typeof event.usedTokens === "number" ? event.usedTokens : null,
					size: typeof event.contextWindow === "number" ? event.contextWindow : null,
					estimated: true,
					attach: "currentOrLast",
				});
				break;
			}

			case "message_update": {
				const asst = event.assistantMessageEvent as Record<string, unknown> | undefined;
				const parentRef = event.parentRef
					? String(event.parentRef)
					: (event.parentToolCallId ? String(event.parentToolCallId) : undefined);
				deltas.push(...translateMessageUpdate(asst, this, ctx.providerOptions, parentRef));
				break;
			}

			case "message_end": {
				const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
				const res = translateMessageEnd(msg, this.currentAgentText, this.openThinkingChannels);
				deltas.push(...res.deltas);
				this.currentAgentText = res.nextAgentText;
				break;
			}

			case "tool_execution_start": {
				const { shape, delta } = translateToolStart(event, fallbackCwd);
				this.activeTools.set(String(event.toolCallId), shape);
				deltas.push(delta);
				break;
			}

			case "tool_execution_update": {
				const callId = String(event.toolCallId);
				const cached = this.activeTools.get(callId);
				if (cached && event.details && typeof event.details === "object") {
					const detailsObj = event.details as Record<string, unknown>;
					if (detailsObj.conversationId !== undefined && detailsObj.conversationId !== null) {
						cached.childRef = String(detailsObj.conversationId);
					}
				}
				const delta = translateToolUpdate(event);
				if (delta) deltas.push(delta);
				break;
			}

			case "tool_execution_end": {
				const callId = String(event.toolCallId);
				const cachedShape = this.activeTools.get(callId);
				this.activeTools.delete(callId);
				deltas.push(translateToolEnd(event, cachedShape, fallbackCwd));
				break;
			}

			case "tasks_snapshot": {
				// The graph spans the whole session, so it stays on the parent thread while subagents run.
				const steps = Array.isArray(event.steps) ? (event.steps as ThreadEventPlanStep[]) : [];
				if (steps.length === 0) break;
				const item = { type: "planSteps" as const, steps };
				const presentation = planStepsPresentation(steps);
				deltas.push(
					{ kind: "item.open", key: { channel: TASKS_CHANNEL }, item, presentation },
					{ kind: "item.close", key: { channel: TASKS_CHANNEL }, status: "completed", item, presentation },
				);
				break;
			}

			case "auto_retry_start":
			case "auto_retry_end":
			case "turn_end":
				break;

			case "agent_end": {
				const res = translateAgentEnd(event, this.currentAgentText, this.turnBoundarySent);
				deltas.push(...res.deltas);
				this.currentAgentText = "";
				this.turnBoundarySent = res.turnBoundarySent;
				this.turnOpenSent = false;
				this.turnBoundarySent = false;
				break;
			}
		}

		return deltas;
	}
}
