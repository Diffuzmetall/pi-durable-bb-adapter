import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationHandle, type Task } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./documents.ts";

const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;
const GATHER_MS = 50;

type CourierState = { phase: "gather" | "next" | "send" | "hold" };
export type CourierTask = Task<null, CourierState, null, object>;
type Admission = (conversation: ConversationHandle, requestId: string, context: Context) => Promise<void>;

export function courierFor(admit?: Admission): CourierTask {
	return defineTask<null, CourierState, null>({
		name: "bb.subagent-courier", version: 1,
		initial: () => ({ phase: "gather" }),
		phases: {
			gather: async (_task, runtime, context) => {
				await runtime.sleep(runtime.now() + GATHER_MS, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
			next: async (task, runtime, context) => runtime.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, runtime.conversationId);
				if (state.deliveryHold !== undefined) return { status: "running", checkpoint: { phase: "hold" } };
				if (state.sending === undefined) {
					const reports = state.outbox ?? [];
					if (reports.length === 0) {
						if (state.courier === task.id) delete state.courier;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					const batch = (state.batchNumber ?? 0) + 1;
					state.batchNumber = batch;
					state.outbox = [];
					state.sending = { requestId: `subagent-batch:${task.id}:${batch}`, reports };
				}
				return { status: "running", checkpoint: { phase: "send" } };
			}, context),
			send: async (_task, runtime, context) => {
				const state = await runtime.snapshot(SubagentsDoc, runtime.conversationId, context);
				const sending = state?.sending;
				if (sending === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				const parent = (await runtime.conversation(runtime.conversationId, context))!;
				try {
					await admit?.(parent, sending.requestId, context);
				} catch (error) {
					if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
					const reason = error instanceof Error ? error.message : String(error);
					await runtime.commit(async (tx) => {
						const current = await tx.doc(SubagentsDoc, runtime.conversationId);
						if (current.sending?.requestId === sending.requestId) {
							current.deliveryHold = { kind: "admission", requestId: sending.requestId, reason };
						}
						return { status: "running", checkpoint: { phase: "hold" } };
					}, context);
					return;
				}
				const submission = await parent.submit({
					type: "input",
					content: sending.reports.map((report) => report.text).join("\n\n"),
					whenBusy: "followUp",
					requestId: sending.requestId,
				}, context);
				const settled = await submission.wait(context);
				await runtime.commit(async (tx) => {
					const current = await tx.doc(SubagentsDoc, runtime.conversationId);
					if (current.sending?.requestId !== sending.requestId) {
						return { status: "running", checkpoint: { phase: "next" } };
					}
					if (settled.status === "done") {
						delete current.sending;
					} else {
						current.deliveryHold = { kind: "uncertain", requestId: sending.requestId, reason: `Delivery outcome uncertain: ${settled.status}` };
					}
					return { status: "running", checkpoint: { phase: settled.status === "done" ? "next" : "hold" } };
				}, context);
			},
			hold: async (_task, runtime, context) => {
				const watch = await runtime.watchDoc(SubagentsDoc, runtime.conversationId, context);
				if (watch === undefined || watch.value?.deliveryHold === undefined) {
					await watch?.stop();
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				try {
					await new Promise<void>((resolve, reject) => {
						watch.start((value) => {
							if (value?.deliveryHold === undefined) resolve();
							return Promise.resolve();
						});
					void watch.closed.then(() => reject(new Error("Courier hold watch ended")));
				});
				} finally {
					await watch.stop();
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
		},
		abort: async (_task, runtime, context) => runtime.commit(() => ({
			status: "terminal", outcome: { status: "aborted" },
		}), context),
	});
}

