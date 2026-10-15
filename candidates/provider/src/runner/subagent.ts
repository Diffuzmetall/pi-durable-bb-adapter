import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

export function buildRoleEnvelope(task: string): string {
	return [
		"You are an isolated worker subagent.",
		`Your ONLY goal is to solve the delegated task: "${task}".`,
		"Rules:",
		"- Focus strictly on solving the assigned task using your available tools.",
		"- Do not attempt repository-wide meta-discovery, git archaeology, or searching for other agents.",
		"- Execute the task and return your final answer concisely.",
	].join("\n");
}

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? "";
}

/**
 * A subagent extension: each call creates a child conversation owned by the call's task,
 * sets a strict role envelope, runs the task there asynchronously by default (background: true),
 * and links with Beyond Boundaries subthreads.
 */
export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained task to an async subagent. Runs in the background by default without blocking the conversation.",
			parameters: Type.Object({
				task: Type.String({ description: "What the subagent should do" }),
				background: Type.Optional(
					Type.Boolean({
						description:
							"Run in background asynchronously (default: true). Set false only if an immediate synchronous answer is strictly required.",
						default: true,
					}),
				),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const isBackground = args.background !== false;
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { instructions: buildRoleEnvelope(args.task) });
					return created.id;
				}, context);

				await api.details({ conversationId: child, task: args.task, background: isBackground }, context);
				const handle = await api.conversation(child, context);
				if (!handle) {
					throw new Error(`Failed to access subagent conversation: ${child}`);
				}
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const submission = await handle.submit(request, context);

				if (isBackground) {
					return {
						output: [
							{
								type: "text",
								text: `Subagent spawned in background (conversation ${child}). The task is running independently and will report upon completion.`,
							},
						],
						details: { conversationId: child, background: true, task: args.task },
					};
				}

				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				return { output: [{ type: "text", text }], details: { conversationId: child, background: false, task: args.task } };
			},
		}),
	],
});
