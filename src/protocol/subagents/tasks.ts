// Anchor/Reporter ownership ported from pi-pocket src/server/extensions/subagents.ts.
// Origin license: MIT, Copyright (c) 2026 Tanner Middleton; see LICENSE.pocket.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry, defineTask, type ConversationHandle, type ConversationId,
	type EntryId, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./documents.ts";
import type { CourierTask } from "./delivery.ts";

export type SubagentAdmission = (child: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "bb.subagent-anchor", version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(
		() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
	abort: (_task, runtime, context) => runtime.commit(
		() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export async function answerText(
	api: Pick<ToolExecutionApi, "commit">, answer: EntryId, context: Context,
): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
}

type ReporterInput = { key: string; conversationId: ConversationId; task: string; requestId: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; text: string };

export function reporterFor(courier: CourierTask, admit?: SubagentAdmission) {
	return defineTask<ReporterInput, ReporterState, null>({
		name: "bb.subagent-reporter", version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const child = (await runtime.conversation(task.input.conversationId, context))!;
				await admit?.(child, task.input.requestId, context);
				const submission = await child.submit({ type: "input", content: task.input.task,
					requestId: task.input.requestId }, context);
				const settled = await submission.wait(context);
				await runtime.commit(async (tx) => {
					const record = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[task.input.key]!;
					let text = `Subagent ${record.name} failed: ${settled.status}`;
					if (settled.status === "unanswered") text += ` (${settled.reason})`;
					if (settled.status === "done" && settled.type === "input") {
						const entry = await tx.entry(AssistantEntry, settled.answer);
						const message = entry?.model?.[0] as AssistantMessage | undefined;
						text = `Subagent ${record.name} answered: ` + (message?.content ?? [])
							.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
					}
					record.report = text;
					record.settled = true;
					return { status: "running", checkpoint: { phase: "report", text } };
				}, context);
			},
			report: async (task, runtime, context) => {
				await runtime.commit(async (tx) => {
					const state = await tx.doc(SubagentsDoc, runtime.conversationId);
					if (!(state.outbox ?? []).some((report) => report.id === String(task.id))) {
						state.outbox = [...(state.outbox ?? []), {
							id: String(task.id), name: state.agents[task.input.key]?.name ?? task.input.key,
							text: task.state.checkpoint.text,
						}];
					}
					const active = state.courier === undefined ? undefined : await tx.task(state.courier);
					if (active?.state.status !== "pending" && active?.state.status !== "running" && active?.state.status !== "waiting") {
						state.courier = await tx.createTask(courier, null, BACKGROUND);
					}
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}
