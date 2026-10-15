import type { LiveState, NestedToolSlot, TaskGraphNode, ToolSlot } from "@earendil-works/pi-durable";
import { resolveToolCallArgs } from "./bridge/tool-args-resolver.ts";
import type { DurableView } from "./runtime-types.ts";

/** Longest a step's name may be; the panel is narrow, and a command's tail is rarely the informative part. */
const MAX_NAME = 48;

/** Names for the harness tasks the graph knows only by kind, complete as they stand. */
const KIND_NAMES: Record<string, string> = {
	"pi.generation": "assistant turn",
	"pi.compaction": "compacting context",
};

/** Argument fields worth showing, in the order that reads best for the tool. */
const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "prompt"];

function clip(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= MAX_NAME ? oneLine : `${oneLine.slice(0, MAX_NAME - 1)}…`;
}

function argumentHint(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return clip(value);
	}
	return undefined;
}

function liveOf(view: DurableView): LiveState {
	// A view always carries pi.live, but a caller's partial one must not take the bridge down with it.
	const raw = view?.conversation?.docs?.["pi.live"];
	return typeof raw === "object" && raw !== null ? (raw as LiveState) : {};
}

function isNested(slot: ToolSlot | NestedToolSlot): slot is NestedToolSlot {
	return "parentCallId" in slot;
}

/**
 * What each task is doing, taken from the harness's own record of the call running in it: `pi.live` relates a slot to
 * its task by ID, and a graph node carries no payload of its own (spec §9.5). A call that was never offered has no
 * slot and so no name; a name learned stays learned, since the slot leaves `pi.live` when the call ends.
 */
export class TaskNames {
	private readonly names = new Map<string, string>();

	public learn(view: DurableView): void {
		const live = liveOf(view);
		for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
			if (slot.taskId === undefined) continue;
			const key = String(slot.taskId);
			if (this.names.has(key)) continue;
			// A nested slot carries the arguments it runs with; a model-issued call's are in its assistant entry.
			const args = isNested(slot) ? slot.arguments : resolveToolCallArgs(slot.callId, view);
			const hint = argumentHint(args);
			this.names.set(key, clip(hint === undefined ? slot.name : `${slot.name}: ${hint}`));
		}
	}

	public get(taskId: string): string | undefined {
		return this.names.get(taskId);
	}
}

/** How the plan panel names one task: the call it is running, otherwise its kind in plain words. */
export function taskLabel(node: TaskGraphNode, names?: TaskNames): string {
	const state = node.state;
	const call = names?.get(String(node.id));
	const plain = KIND_NAMES[node.kind];
	const kind = call ?? plain ?? (node.kind.startsWith("pi.") ? node.kind.slice(3) : node.kind);
	if (state.status === "waiting") return `${kind} · waiting on ${state.on.length}`;
	if (state.status === "completing") return `${kind} · completing (${state.outcome})`;
	// A named task says what it does; the phase of an unnamed one is all there is to show.
	return call !== undefined || plain !== undefined ? kind : `${kind} · ${state.phase}`;
}
