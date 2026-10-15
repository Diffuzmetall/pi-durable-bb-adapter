import type { AgentEvent, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";

/** Rehydrate the active presentation without resubmitting a run or replaying old root turns. */
export function sharedReplay(snapshot: SnapshotEvent, child: boolean): AgentEvent[] {
	const events: AgentEvent[] = [snapshot];
	if (snapshot.run) events.push({ type: "run_start", inputs: snapshot.run.inputs });
	for (const slot of [...snapshot.tools, ...snapshot.nestedTools]) {
		if (slot.status !== "running") continue;
		const call = { toolCallId: slot.callId, toolName: slot.name };
		events.push({ type: "tool_execution_start", ...call, args: "arguments" in slot ? slot.arguments : {} });
		events.push({ type: "tool_execution_update", ...call,
			...(slot.details === undefined ? {} : { details: slot.details }),
			...(slot.output === undefined ? {} : { output: { set: slot.output } }) });
	}
	const entry = snapshot.entries.findLast((e) => e.model?.[0]?.role === "assistant");
	const message = snapshot.generation?.message ?? (!snapshot.run && child ? entry?.model?.[0] : undefined);
	if (message?.role === "assistant") {
		const changes: MessageChange[] = [];
		for (const [contentIndex, part] of message.content.entries()) {
			if (part.type === "text") changes.push({ type: "text_delta", delta: part.text, contentIndex });
			if (part.type === "thinking") changes.push({ type: "thinking_delta", delta: part.thinking, contentIndex });
		}
		events.push({ type: "message_update", usage: message.usage, changes });
	}
	// A fast child may already have completed before its parent published/discovered the ID.
	if (child && !snapshot.run && entry) events.push({ type: "message_end", entry }, { type: "run_end", inputs: [] });
	return events;
}

/** Each replacement snapshot supersedes undelivered commits, not already-delivered text. */
export function createSharedReplay(child: boolean) {
	let initialized = false, running = false, lastEntry = 0, runKey = "";
	const blocks = new Map<string, string>();
	const tools = new Map<string, Extract<AgentEvent, { type: "tool_execution_start" }>>();
	return (batch: readonly AgentEvent[]): AgentEvent[] => {
		const output: AgentEvent[] = [];
		const deliver = (event: AgentEvent, replacement = false) => {
			if (event.type === "run_start") {
				if (replacement && running) return;
				running = true; runKey = JSON.stringify(event.inputs); blocks.clear();
			}
			if (event.type === "run_end") { running = false; runKey = ""; }
			if (event.type === "message_start" && event.message.role === "assistant") blocks.clear();
			if (event.type === "message_update") {
				const changes: MessageChange[] = [];
				for (const change of event.changes) {
					if (change.type !== "text_delta" && change.type !== "thinking_delta") { changes.push(change); continue; }
					const key = `${change.type}:${change.contentIndex}`, previous = blocks.get(key) ?? "";
					const delta = replacement && change.delta.startsWith(previous) ? change.delta.slice(previous.length) : change.delta;
					blocks.set(key, replacement ? change.delta : previous + change.delta);
					if (delta) changes.push({ ...change, delta });
				}
				if (!changes.length) return;
				event = { ...event, changes };
			}
			if (event.type === "message_end") { lastEntry = Math.max(lastEntry, Number(event.entry.id)); blocks.clear(); }
			if (event.type === "tool_execution_start") {
				if (replacement && tools.has(event.toolCallId)) return;
				tools.set(event.toolCallId, event);
			}
			if (event.type === "tool_execution_end") tools.delete(event.toolCallId);
			output.push(event);
		};
		for (const event of batch) {
			if (event.type !== "snapshot") { deliver(event); continue; }
			const tail = event.entries.at(-1);
			// Recover completed messages and tools whose final commits were replaced by this snapshot.
			if (initialized) {
				for (const entry of event.entries) if (Number(entry.id) > lastEntry && entry.model?.[0]?.role === "assistant")
					deliver({ type: "message_end", entry });
				const active = new Set([...event.tools, ...event.nestedTools].filter((s) => s.status === "running").map((s) => s.callId));
				for (const [callId, call] of tools) if (!active.has(callId)) {
					const entry = event.entries.findLast((e) => e.model?.[0]?.role === "toolResult" && e.model[0].toolCallId === callId);
					deliver({ ...call, type: "tool_execution_end", ...(entry ? { entry } : {}) });
				}
			}
			if (initialized && running && runKey !== JSON.stringify(event.run?.inputs))
				deliver({ type: "run_end", inputs: [] });
			const replay = sharedReplay(event, child && !initialized);
			for (const item of replay) deliver(item, true);
			lastEntry = Math.max(lastEntry, Number(tail?.id) || 0); initialized = true;
		}
		return output;
	};
}
