import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { Conversation, ConversationId, ConversationView, Cursor, Harness, TaskGraph } from "@earendil-works/pi-durable";
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { ExecutionEnvs, findInitialAgentModel } from "./harness-setup.ts";
import { selectSession } from "./session-storage.ts";
import {
	agentOf, firstInput, titleOf, type ConversationSummary, type DurableView,
	type ModelSummary, type Notice, type OpenDurableOptions, type OpenDurableResult, runtimeContext,
} from "./runtime-types.ts";
import { createDurableController } from "./runtime-controller.ts";
import { loadHarnessEnvironment, type LoadedHarnessEnvironment } from "./runtime-loader.ts";

export * from "./runtime-types.ts";
export * from "./runtime-controller.ts";

async function loadSummaries(harness: Harness, rootId: ConversationId): Promise<ConversationSummary[]> {
	const label = (id: ConversationId): string => (id === rootId ? "main" : `subagent ${id}`);
	const summaries: ConversationSummary[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
		for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(harness, id)) });
		cursor = page.next;
	} while (cursor !== undefined);
	return summaries;
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;
	let envState: LoadedHarnessEnvironment | undefined;

	try {
		const activeEnvState = await loadHarnessEnvironment(location, options, envs);
		envState = activeEnvState;
		const { modelRuntime, settingsManager } = activeEnvState;
		harness = activeEnvState.harness;

		const root = await harness.root(runtimeContext, {
			agent: {
				cwd: location.cwd,
				...(activeEnvState.initialModelRef ? { model: activeEnvState.initialModelRef } : {}),
				...(activeEnvState.initialThinkingLevel ? { thinkingLevel: activeEnvState.initialThinkingLevel } : {}),
			},
		});

		if (!location.created) {
			const rootAgent = await root.agent(runtimeContext);
			if (rootAgent.model) activeEnvState.setActiveModelRef(rootAgent.model);
			if (options.cli !== undefined) {
				const cli = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
				if (cli.model) {
					activeEnvState.setActiveModelRef(cli.model);
					await root.configure({ model: cli.model, thinkingLevel: cli.thinkingLevel }, runtimeContext);
				} else if (cli.thinkingLevel !== undefined) {
					await root.configure({ thinkingLevel: cli.thinkingLevel }, runtimeContext);
				}
			}
		}

		const summaries = await loadSummaries(harness, root.id);
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(runtimeContext);

		const enabled = settingsManager.getEnabledModels();
		const scoped = enabled?.length ? await resolveModelScopeWithDiagnostics(enabled, modelRuntime) : undefined;
		const scopedList = scoped?.scopedModels?.length ? scoped.scopedModels.map((sm) => sm.model) : modelRuntime.getAvailableSnapshot();
		const models = (): ModelSummary[] =>
			scopedList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, contextWindow: m.contextWindow }));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};

		const listeners = new Set<() => void>();
		let notifying = false;
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};

		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (err: unknown): void => notice("error", err instanceof Error ? err.message : String(err));
		for (const report of activeEnvState.pendingReports) {
			if (report && typeof report === "object" && "kind" in report && (report as { kind?: string }).kind === "notice") {
				const nr = report as unknown as { level: Notice["level"]; message: string };
				notice(nr.level, nr.message);
			} else {
				notice("warning", report instanceof Error ? report.message : String(report));
			}
		}
		activeEnvState.setNoticeForwarder?.((level, message) => notice(level, message));

		let unsubscribeConversation = conversation.subscribe((val) => update({ conversation: val }));
		const unsubscribeCommits = harness.subscribeCommits((pub) => {
			let convs = state.conversations;
			for (const ch of pub.changes) {
				if (ch.type === "conversation") {
					convs = [...convs, { id: ch.value.id, label: ch.value.id === root.id ? "main" : `subagent ${ch.value.id}` }];
				} else if (ch.type === "entry" && ch.value.kind === "pi.user") {
					const id = ch.value.conversationId;
					convs = convs.map((s) => s.id === id && !s.title ? { ...s, ...titleOf(ch.value) } : s);
				}
			}
			if (convs !== state.conversations) update({ conversations: convs });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => { unsubscribeTasks(); tasks?.dispose(); tasks = undefined; };

		const opened = harness;
		const controller = createDurableController({
			getCurrent: () => current,
			setCurrent: (c) => { current = c; },
			getConversationState: () => conversation,
			setConversationState: (cs) => { conversation = cs; },
			getUnsubscribeConversation: () => unsubscribeConversation,
			setUnsubscribeConversation: (fn) => { unsubscribeConversation = fn; },
			opened,
			modelRuntime,
			getState: () => state,
			update,
			notice,
			fail,
			getTasks: () => tasks,
			setTasks: (t) => { tasks = t; },
			setUnsubscribeTasks: (fn) => { unsubscribeTasks = fn; },
			closeTasks,
			setActiveModelRef: (ref) => activeEnvState.setActiveModelRef(ref),
			extensionRunner: activeEnvState.extensionRunner,
			dynamicSections: activeEnvState.dynamicSections,
			cwd: location.cwd,
		});

		const saved = agentOf(state.conversation).model;
		if (!saved) notice("warning", "No model configured; select one with /model.");
		else if (!modelRuntime.getModel(saved.provider, saved.modelId)) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (activeEnvState.fallbackMessage) notice("info", activeEnvState.fallbackMessage);

		await controller.toggleTasks();
		harness.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
			},
			controller,
			settings: settingsManager,
			modelRuntime,
			harness,
			close() {
				return closing ??= (async () => {
					unsubscribeConversation();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						await opened.close(runtimeContext);
						await envs.cleanup(runtimeContext);
						await activeEnvState.cleanup?.();
					} finally {
						await location.release();
					}
				})();
			},
		};
	} catch (error: unknown) {
		await envState?.cleanup?.().catch((err: unknown) => console.warn("[DurableRuntime] Cleanup extension runner:", err));
		await harness?.close(runtimeContext).catch((err: unknown) => console.warn("[DurableRuntime] Cleanup harness:", err));
		await location.release().catch((err: unknown) => console.warn("[DurableRuntime] Cleanup location:", err));
		throw error;
	}
}
