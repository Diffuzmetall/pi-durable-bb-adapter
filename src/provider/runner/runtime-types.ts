import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentState,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	type Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptOptions } from "./prompt.ts";

export const runtimeContext = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	readonly title?: string;
}

export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

export interface DurableController {
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	switchConversation(id: ConversationId): Promise<void>;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
	readonly session?: string;
	readonly cli?: { readonly provider?: string; readonly model: string; readonly thinking?: ModelThinkingLevel };
	readonly prompt?: PromptOptions;
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	readonly settings: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly harness: Harness;
	close(): Promise<void>;
}

export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

export function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

export async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, runtimeContext))!;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, runtimeContext);
		first = [...page.items].reverse().find((entry) => entry.kind === "pi.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
}
