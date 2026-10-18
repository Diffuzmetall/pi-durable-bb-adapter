import { experimental_planStepsPresentation as planStepsPresentation, type ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import {
	translateToolStart,
	translateToolUpdate,
	translateToolEnd,
} from "../../provider/host/tool-delta-translator.ts";
import {
	translateMessageUpdate,
	translateMessageEnd,
	translateAgentEnd,
} from "../../provider/host/message-delta-translator.ts";
import type { RunnerEvent, ThreadDelta } from "../../provider/host/types.ts";

/** Timeline channel of the durable task graph; stable so every snapshot closes over the same key. */
const TASKS_CHANNEL = "pi-durable-tasks";

function graphSnapshotDelta(steps: ThreadEventPlanStep[]): ThreadDelta {
	// Thread-scoped SDK output: the observation is not an executing model turn.
	return { kind: "item.close", key: { channel: TASKS_CHANNEL }, status: "pending",
		item: { type: "backgroundTask", familyId: TASKS_CHANNEL,
			taskType: "pi-durable-runtime-graph", skipTranscript: true,
			description: "Runtime task graph", status: "pending",
			taskStatus: steps.some(step => step.status === "active") ? "running" : "pending",
			summary: steps.length === 0 ? "No active runtime tasks" : steps.map(step => `${step.status ?? "pending"}: ${step.step}`).join("\n"),
		},
	};
}

function failedAgentEnd(event: RunnerEvent): boolean {
	const message = event.message ?? (Array.isArray(event.messages) ? event.messages[0] : undefined);
	if (event.stopReason === "error") return true;
	if (!message || typeof message !== "object") return false;
	const finalMessage = message as Record<string, unknown>;
	if (finalMessage.stopReason === "error") return true;
	if (event.aborted === true || event.stopReason === "aborted" || finalMessage.stopReason !== "stop") return false;

	// The Durable bridge's no-model failure can end without an assistant entry and synthesize
	// only an empty, zero-usage final message. Never turn that idle artifact into success.
	const content = finalMessage.content;
	const usage = finalMessage.usage;
	if (!Array.isArray(content) || !usage || typeof usage !== "object") return false;
	const hasOutput = content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const block = part as Record<string, unknown>;
		return (block.type === "text" && typeof block.text === "string" && block.text.length > 0) ||
			(block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) ||
			block.type === "toolCall";
	});
	if (hasOutput) return false;
	const metrics = usage as Record<string, unknown>;
	return Number(metrics.totalTokens ?? 0) === 0 && Number(metrics.input ?? 0) === 0 && Number(metrics.output ?? 0) === 0;
}

export interface DeltaTranslatorContext {
	threadId: string;
	ownsTurn?: boolean;
	cwd?: string;
	clientRequestId?: string;
	providerOptions?: Record<string, unknown>;
}

export class DeltaTranslator {
	private activeTools = new Map<string, Record<string, unknown>>();
	private taskSequences = new Map<string, number>();
	private taskPublishers = new Map<string, { epoch: string; sequence: number }>();
	private retiredTaskEpochs = new Map<string, Set<string>>();
	public currentThinkingIndex = 0;
	public currentAgentText = "";
	private turnOpenSent = false;
	private turnBoundarySent = false;
	public openThinkingChannels = new Set<string>();

	public reset(): void {
		for (const [threadId, publisher] of this.taskPublishers) {
			const retired = this.retiredTaskEpochs.get(threadId) ?? new Set<string>();
			retired.add(publisher.epoch);
			this.retiredTaskEpochs.set(threadId, retired);
		}
		this.taskPublishers.clear();
		this.taskSequences.clear();
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
				if (ctx.ownsTurn === false) break;
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
				if (!Array.isArray(event.steps)) break;
				if (event.epoch !== undefined) {
					if (typeof event.epoch !== "string" || !event.epoch ||
						!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) break;
					const retired = this.retiredTaskEpochs.get(ctx.threadId) ?? new Set<string>();
					if (retired.has(event.epoch)) break;
					const previous = this.taskPublishers.get(ctx.threadId);
					const sequence = event.sequence as number;
					if (previous?.epoch === event.epoch && sequence <= previous.sequence) break;
					if (previous?.epoch !== event.epoch && sequence !== 1) break;
					if (previous && previous.epoch !== event.epoch) retired.add(previous.epoch);
					this.retiredTaskEpochs.set(ctx.threadId, retired);
					this.taskPublishers.set(ctx.threadId, { epoch: event.epoch, sequence });
				} else {
					if (this.taskPublishers.has(ctx.threadId) || this.retiredTaskEpochs.has(ctx.threadId)) break;
					const last = this.taskSequences.get(ctx.threadId);
					if (event.sequence !== undefined) {
						if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) break;
						const sequence = event.sequence as number;
						if (last !== undefined && sequence <= last) break;
						this.taskSequences.set(ctx.threadId, sequence);
					} else if (last !== undefined) break;
				}
				const steps = event.steps as ThreadEventPlanStep[];
				if (!this.turnOpenSent) {
					deltas.push(graphSnapshotDelta(steps));
					break;
				}
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
				const isFailure = failedAgentEnd(event);
				const res = translateAgentEnd(event, this.currentAgentText, this.turnBoundarySent);
				deltas.push(...res.deltas.map((delta) =>
					isFailure && delta.kind === "turn.boundary" && delta.status === "completed"
						? { ...delta, status: "failed" }
						: delta,
				));
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
