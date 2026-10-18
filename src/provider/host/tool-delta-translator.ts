import type { RunnerEvent, ThreadDelta } from "./types.ts";
import {
	normalizeFilePath,
	synthesizeAddDiff,
	normalizeGitPatch,
	resolveFileChangeItem,
} from "./diff-utils.ts";

export { normalizeFilePath, synthesizeAddDiff, normalizeGitPatch, resolveFileChangeItem };

interface RawEditItem {
	oldText?: unknown;
	newText?: unknown;
}

function isDelegationTool(name: string): boolean {
	return name === "subagent" || name === "agent_spawn" || name === "agent_spawn_graph";
}

/**
 * Translates tool execution events into BB thread deltas.
 */
export function buildToolItemShape(
	toolName: string,
	args: Record<string, unknown>,
	fallbackCwd: string,
): Record<string, unknown> {
	if (toolName === "bash") {
		return {
			type: "command",
			command: typeof args.command === "string" ? args.command : "",
			cwd: typeof args.cwd === "string" ? args.cwd : fallbackCwd,
		};
	}

	if (isDelegationTool(toolName)) {
		let task = typeof args.task === "string" ? args.task : "";
		const name = typeof args.name === "string" ? args.name : "";
		if (!task && Array.isArray(args.agents) && args.agents.length > 0) {
			task = `Graph: ${name || "pipeline"} (${args.agents.length} agents)`;
		}
		const defaultLabel = toolName === "agent_spawn_graph" ? `Graph: ${name || "pipeline"}` : (toolName === "subagent" ? "Subagent delegation" : "Agent delegation");
		const label = task ? (task.length > 80 ? `${task.slice(0, 77)}...` : task) : defaultLabel;
		const childRef = String(args.conversationId || args.childRef || name || (toolName === "subagent" ? "subagent" : "agent"));
		const isBackground = args.background !== false;
		return {
			type: "delegation",
			childRef,
			label,
			background: isBackground,
			summary: task || undefined,
		};
	}

	if (toolName === "write") {
		const filePath = normalizeFilePath(args.path, fallbackCwd);
		const newText = typeof args.content === "string" ? args.content : undefined;
		return {
			type: "fileChange",
			changes: filePath
				? [{ path: filePath, kind: "add", ...(newText !== undefined ? { newText } : {}) }]
				: [],
		};
	}

	if (toolName === "edit") {
		const filePath = normalizeFilePath(args.path, fallbackCwd);
		if (!filePath) {
			return { type: "fileChange", changes: [] };
		}
		const edits = Array.isArray(args.edits) ? args.edits : [];
		if (edits.length > 0) {
			const changes = edits.map((edit: unknown) => {
				const e = typeof edit === "object" && edit !== null ? (edit as RawEditItem) : undefined;
				return {
					path: filePath,
					kind: "update",
					...(typeof e?.oldText === "string" ? { oldText: e.oldText } : {}),
					...(typeof e?.newText === "string" ? { newText: e.newText } : {}),
				};
			});
			return { type: "fileChange", changes };
		}
		return {
			type: "fileChange",
			changes: [{ path: filePath, kind: "update" }],
		};
	}

	return {
		type: "tool",
		tool: toolName,
		server: "pi",
		args,
	};
}

function getDelegationPresentation(title: unknown): Record<string, unknown> {
	return {
		label: { pending: "Running subagent", completed: "Subagent completed" },
		icon: { glyph: "Bot" },
		title: String(title ?? "Subagent"),
	};
}

export function translateToolStart(
	event: RunnerEvent,
	fallbackCwd: string,
): { shape: Record<string, unknown>; delta: ThreadDelta } {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const args = (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>;
	const shape = buildToolItemShape(toolName, args, fallbackCwd);

	const presentation = shape.type === "delegation"
		? getDelegationPresentation(shape.label)
		: undefined;

	const parentRef = event.parentRef
		? String(event.parentRef)
		: (event.parentToolCallId ? String(event.parentToolCallId) : undefined);
	const delta: ThreadDelta = {
		kind: "item.open",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		item: {
			...shape,
			...(parentRef ? { parentToolCallId: parentRef } : {}),
		},
		...(presentation ? { presentation } : {}),
	};
	return { shape, delta };
}

export function translateToolUpdate(event: RunnerEvent): ThreadDelta | null {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const parentRef = event.parentRef
		? String(event.parentRef)
		: (event.parentToolCallId ? String(event.parentToolCallId) : undefined);
	if (!event.partialResult) return null;

	if (toolName === "bash") {
		return {
			kind: "command.outputSnapshot",
			key: {
				providerItemId: callId,
				...(parentRef ? { parentRef } : {}),
			},
			text: String(event.partialResult),
		};
	}

	return {
		kind: "item.progress",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		message: String(event.partialResult),
	};
}

export function translateToolEnd(
	event: RunnerEvent,
	cachedShape?: Record<string, unknown>,
	fallbackCwd = process.cwd(),
): ThreadDelta {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const isDelegation = isDelegationTool(toolName);
	const shape = cachedShape ?? {
		type: toolName === "bash" ? "command" : isDelegation ? "delegation" : "tool",
		...(toolName === "bash"
			? { command: "", cwd: fallbackCwd }
			: isDelegation
				? { childRef: "agent", label: "Agent delegation", background: false }
				: { tool: toolName, server: "pi" }),
	};

	const resultText = typeof event.result === "string"
		? event.result
		: JSON.stringify(event.result ?? "");

	const isError = Boolean(event.isError);

	let item = shape;
	if (item.type === "fileChange") {
		item = resolveFileChangeItem(item, event, fallbackCwd);
	} else if (item.type === "tool" && isError) {
		item = {
			...item,
			error: resultText,
		};
	} else if (item.type === "delegation") {
		const detailsObj = typeof event.details === "object" && event.details !== null
			? (event.details as Record<string, unknown>)
			: undefined;
		const conversationId = detailsObj?.conversationId;
		const childRef = conversationId !== undefined && conversationId !== null && String(conversationId).trim() !== ""
			? String(conversationId)
			: (typeof item.childRef === "string" && item.childRef ? item.childRef : "subagent");
		const summary = resultText
			? (resultText.length > 300 ? `${resultText.slice(0, 297)}...` : resultText)
			: (typeof item.summary === "string" ? item.summary : undefined);
		const background = detailsObj?.background !== undefined
			? Boolean(detailsObj.background)
			: (item.background ?? true);
		item = {
			...item,
			childRef,
			summary,
			background,
		};
	}

	const presentation = item.type === "delegation"
		? getDelegationPresentation(item.label)
		: undefined;

	const parentRef = event.parentRef
		? String(event.parentRef)
		: (event.parentToolCallId ? String(event.parentToolCallId) : undefined);

	return {
		kind: "item.close",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		status: isError ? "failed" : "completed",
		exitCode: isError ? 1 : 0,
		resultText,
		aggregatedOutput: item.type === "command" ? resultText : undefined,
		...(isError ? { error: { message: resultText } } : {}),
		item: {
			...item,
			...(parentRef ? { parentToolCallId: parentRef } : {}),
		},
		...(presentation ? { presentation } : {}),
	};
}
