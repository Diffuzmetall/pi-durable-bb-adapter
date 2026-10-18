import type { DurableView } from "../runtime.ts";
import type { LiveState } from "@earendil-works/pi-durable";
import {
	isToolCallBlock,
	isConversationEntryRecord,
	type LiveToolSlotRecord,
} from "./contracts.ts";

/**
 * Resolves tool call arguments from the active generation message or transcript entries.
 * Addresses defect D-1 / A-1 (AP-012, AP-026, AP-029).
 */
export function resolveToolCallArgs(callId: string, current: DurableView): Record<string, unknown> {
	const rawLive = current.conversation.docs["pi.live"];
	const live: LiveState = (typeof rawLive === "object" && rawLive !== null) ? (rawLive as LiveState) : {};

	// 1. Check current live generation message toolCalls
	const rawBlocks: unknown[] = Array.isArray(live.generation?.message?.content)
		? live.generation.message.content
		: [];
	const activeCalls = rawBlocks.filter(isToolCallBlock);
	if (activeCalls.length > 0) {
		const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
		if (matched?.arguments && typeof matched.arguments === "object") {
			return matched.arguments;
		}
	}

	// 2. Check recent assistant entries from the conversation transcript
	const entries = current.conversation.entries ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isConversationEntryRecord(entry) && entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
			for (const msg of entry.model) {
				if (Array.isArray(msg?.content)) {
					for (const part of msg.content) {
						if (isToolCallBlock(part) && (part.id === callId || part.callId === callId)) {
							if (part.arguments && typeof part.arguments === "object") {
								return part.arguments;
							}
						}
					}
				}
			}
		}
	}

	// 3. Fallback to slot input / args
	const rawTools: unknown[] = Array.isArray(live.tools) ? live.tools : [];
	const slot = rawTools.find((s): s is LiveToolSlotRecord => {
		if (typeof s !== "object" || s === null) return false;
		const candidate = s as LiveToolSlotRecord;
		const sid = candidate.callId ?? (candidate.id !== undefined ? String(candidate.id) : undefined);
		return sid === callId;
	});
	if (slot?.args && typeof slot.args === "object") {
		return slot.args;
	}

	return {};
}
