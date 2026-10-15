import type { AttachedReplicatedState } from "@earendil-works/chord";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	ConversationView,
	Harness,
	ModelRef,
	Submission,
	TaskGraph,
} from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agentOf, type DurableController, type DurableView, type Notice, runtimeContext } from "./runtime-types.ts";

export interface ControllerContext {
	getCurrent: () => Conversation;
	setCurrent: (c: Conversation) => void;
	getConversationState: () => AttachedReplicatedState<ConversationView>;
	setConversationState: (cs: AttachedReplicatedState<ConversationView>) => void;
	getUnsubscribeConversation: () => () => void;
	setUnsubscribeConversation: (fn: () => void) => void;
	opened: Harness;
	modelRuntime: ModelRuntime;
	getState: () => DurableView;
	update: (patch: Partial<DurableView>) => void;
	notice: (level: Notice["level"], message: string) => void;
	fail: (error: unknown) => void;
	getTasks: () => AttachedReplicatedState<TaskGraph> | undefined;
	setTasks: (t: AttachedReplicatedState<TaskGraph> | undefined) => void;
	setUnsubscribeTasks: (fn: () => void) => void;
	closeTasks: () => void;
	setActiveModelRef: (ref: ModelRef) => void;
	extensionRunner?: import("@earendil-works/pi-coding-agent").ExtensionRunner;
	dynamicSections?: import("./prompt.ts").DynamicPromptSections;
	cwd?: string;
}

export function createDurableController(ctx: ControllerContext): DurableController {
	let queue = Promise.resolve();
	const command = (operation: () => Promise<void>): Promise<void> => {
		queue = queue.then(operation).catch(ctx.fail);
		return queue;
	};

	const watchAnswer = (submission: Submission): void => {
		void submission.wait(runtimeContext).then((settled) => {
			if (settled.status === "unanswered" && settled.reason !== "aborted") {
				ctx.notice(
					"error",
					`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
				);
			}
		}, ctx.fail);
	};

	const agentModel = () => {
		const ref = agentOf(ctx.getState().conversation).model;
		const model = ref === undefined ? undefined : ctx.modelRuntime.getModel(ref.provider, ref.modelId);
		if (model === undefined) {
			throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
		}
		return model;
	};

	return {
		submit: (text, whenBusy) =>
			command(async () => {
				if (ctx.extensionRunner && ctx.dynamicSections) {
					try {
						const hookRes = await ctx.extensionRunner.emitBeforeAgentStart(
							{ messageType: "user", prompt: text, images: undefined },
							{
								cwd: ctx.cwd ?? process.cwd(),
								sections: ctx.dynamicSections.getSections(),
							} as import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
						);
						if (hookRes?.systemPromptOptions?.sections) {
							ctx.dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
						}
					} catch (err) {
						ctx.notice(
							"warning",
							`before_agent_start error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				return watchAnswer(await ctx.getCurrent().submit({ type: "input", content: text, whenBusy }, runtimeContext));
			}),

		compact: (instructions) =>
			command(async () => {
				const id = await ctx.getCurrent().compact(instructions, runtimeContext);
				void ctx.opened.waitForTask(id, runtimeContext).then(async (receipt) => {
					const outcome = receipt.state.outcome;
					if (outcome.status === "completed") {
						const { entryId, submissionId } = outcome.result;
						const status =
							submissionId === undefined
								? undefined
								: (await (await ctx.opened.submission(submissionId, runtimeContext))?.status(runtimeContext))?.status;
						ctx.notice(
							"info",
							entryId !== undefined || status === "done"
								? "Compacted."
								: status === "queued"
									? "Compaction summary queued; it is placed at the next turn boundary."
									: status === "unanswered"
										? "Compaction summary dropped: the context changed under it."
										: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
						);
					} else if (outcome.status === "aborted") {
						ctx.notice("info", "Compaction aborted.");
					} else {
						ctx.notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}
				}, ctx.fail);
			}),

		abort: () => ctx.getCurrent().abort(runtimeContext).catch(ctx.fail),

		cycleThinking: () =>
			command(async () => {
				const model = agentModel();
				if (!model.reasoning) throw new Error("Current model does not support thinking");
				const levels = getSupportedThinkingLevels(model);
				const level = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
				const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
				await ctx.getCurrent().configure({ thinkingLevel: next }, runtimeContext);
			}),

		setThinkingLevel: (targetLevel: ModelThinkingLevel) =>
			command(async () => {
				const model = agentModel();
				if (!model.reasoning) throw new Error("Current model does not support thinking");
				await ctx.getCurrent().configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, runtimeContext);
			}),

		setModel: (ref) =>
			command(async () => {
				const model = ctx.modelRuntime.getModel(ref.provider, ref.modelId);
				if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
				ctx.setActiveModelRef(ref);
				const thinking: ModelThinkingLevel = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
				await ctx.getCurrent().configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, runtimeContext);
			}),

		toggleTasks: () =>
			command(async () => {
				if (ctx.getTasks() !== undefined) {
					ctx.closeTasks();
					ctx.update({ tasks: undefined });
					return;
				}
				const graph = await ctx.opened.taskGraph(runtimeContext);
				ctx.setTasks(graph);
				ctx.setUnsubscribeTasks(graph.subscribe((value) => ctx.update({ tasks: value })));
			}),

		switchConversation: (id: ConversationId) =>
			command(async () => {
				const next = await ctx.opened.conversation(id, runtimeContext);
				if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
				const nextState = await next.viewState(runtimeContext);
				ctx.getUnsubscribeConversation()();
				ctx.getConversationState().dispose();
				ctx.setCurrent(next);
				ctx.setConversationState(nextState);
				ctx.setUnsubscribeConversation(nextState.subscribe((value) => ctx.update({ conversation: value })));
			}),
	};
}
