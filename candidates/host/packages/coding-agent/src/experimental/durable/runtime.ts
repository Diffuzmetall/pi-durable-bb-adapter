import type { AttachedReplicatedState, Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentState,
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Submission,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { DurableExtensions } from "./extensions.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { type DurableMcpSelection, openConfiguredDurableMcp, openDurableMcp } from "./mcp.ts";
import { selectSession } from "./sessions.ts";
import { createSubagent } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Cross-module hand-off for the Hindsight controller installed by hindsight/adapter.mjs. The
 * adapter creates the controller during registry reload and attaches it under this global symbol;
 * this runtime binds it to the live Harness after open and drains it on shutdown.
 */
const HINDSIGHT_CONTROLLER = Symbol.for("pi.durable.hindsight.controller");

/** Delivery counts reported by the Hindsight controller on drain. */
interface HindsightDeliveryStatus {
	readonly pending: number;
	readonly uncertain: number;
	readonly accepted: number;
}

/** The host-bound Hindsight controller surface this runtime uses. */
interface HindsightController {
	bind(host: {
		readonly session: Harness;
		readonly storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
		readonly directory: string;
		readonly context: typeof context;
	}): Promise<void>;
	admit(conversation: ConversationHandle, requestId: string, context: Context): Promise<void>;
	submit(conversation: Conversation, content: string, whenBusy: "steer" | "followUp"): Promise<Submission>;
	drain(timeoutMs?: number): Promise<readonly HindsightDeliveryStatus[]>;
	close(timeoutMs?: number): Promise<void>;
}

function hindsightOf(registry: Pick<DurableExtensions, "snapshot">): HindsightController | undefined {
	return (
		registry.snapshot().extension("hindsight") as unknown as
			| { readonly [key: symbol]: HindsightController | undefined }
			| undefined
	)?.[HINDSIGHT_CONTROLLER];
}

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	/** The first user message, for a subagent its task. */
	readonly title?: string;
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	/** The conversation shown and talked to. */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** The live task graph while the task panel is open. */
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the TUI may ask for. */
export interface DurableController {
	/** Prompt when idle; otherwise steer or queue a follow-up. */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	/** Reload explicit Durable registry adapters; optional path admits a new trusted adapter. */
	reload(path?: string): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. */
	switchConversation(id: ConversationId): Promise<void>;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
	readonly session?: string;
	readonly mcp?: DurableMcpSelection | false;
	readonly extensions?: readonly string[];
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	/** pi's settings, for the TUI's theme and terminal capabilities. */
	readonly settings: SettingsManager;
	readonly harness: Harness;
	readonly modelRuntime: ModelRuntime;
	submitTo(id: ConversationId, text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	close(): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

/** A subagent's task: the oldest user message of its conversation. The main conversation needs no title. */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, context))!;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
}

/** The text of a user entry, as a one-line title. */
function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(
		options.cwd ?? process.cwd(),
		options.continueSession ?? false,
		options.session,
	);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;
	let hindsight: HindsightController | undefined;
	let hindsightBound = false;
	let mcp:
		| Awaited<ReturnType<typeof openDurableMcp>>
		| Awaited<ReturnType<typeof openConfiguredDurableMcp>>
		| undefined;
	let conversation: AttachedReplicatedState<ConversationView> | undefined;
	let tasks: AttachedReplicatedState<TaskGraph> | undefined;
	let unsubscribe = (): void => {};
	let unsubscribeCommits = (): void => {};
	let unsubscribeTasks = (): void => {};
	let queue = Promise.resolve();
	const listeners = new Set<() => void>();
	let closing: Promise<void> | undefined;
	const shutdown = (errors: unknown[] = []): Promise<void> => {
		// Model/tool invocations are not on the command queue. Stop child admissions immediately,
		// including while drain is waiting. Harness.close later cancels and joins those invocations
		// before closing SQLite; their hooks must retain the still-open storage until that join.
		hindsightBound = false;
		closing ??= Promise.resolve().then(async () => {
			// Drain admitted controller operations, then detach views before closing their providers.
			const operations = [
				() => queue,
				() => listeners.clear(),
				() => unsubscribe(),
				() => unsubscribeCommits(),
				() => conversation?.dispose(),
				() => unsubscribeTasks(),
				() => tasks?.dispose(),
				async () => {
					const controller = hindsight;
					if (controller === undefined) return;
					const statuses = await controller.drain();
					if (statuses.some((status) => status.pending > 0 || status.uncertain > 0)) {
						console.error("Hindsight delivery retained in SQLite; it reconciles on the next start.");
					}
				},
				() => hindsight?.close(),
				() => harness?.close(context),
				() => envs.cleanup(context),
				() => mcp?.close(),
				() => location.release(),
			];
			for (const operation of operations) {
				try {
					await operation();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Durable shutdown failed");
		});
		return closing;
	};
	try {
		const modelRuntime = await ModelRuntime.create();
		const settingsManager = SettingsManager.create(location.cwd);
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createCodingRegistry(settingsManager, location.cwd);
		registry.install(
			createSubagent(async (child, requestId, childContext) => {
				if (hindsight !== undefined && hindsightBound) await hindsight.admit(child, requestId, childContext);
			}),
		);
		if (options.mcp !== false) {
			mcp = options.mcp
				? await openDurableMcp(options.mcp, location.cwd)
				: await openConfiguredDurableMcp(location.cwd, {
						sessionDirectory: location.directory,
						providerToken: async (provider) => (await modelRuntime.getAuth(provider))?.auth.apiKey,
						onMailIdentity: (name, project) => {
							process.env.AGENT_MAIL_AGENT = name;
							process.env.AGENT_MAIL_PROJECT = project;
						},
					});
			registry.install(mcp.extension);
		}

		const extensions = new DurableExtensions(registry, location.cwd, options.extensions);
		await extensions.reload(async () => {});
		hindsight = hindsightOf(extensions);
		if (hindsight) Object.defineProperty(registry, HINDSIGHT_CONTROLLER, { value: hindsight, configurable: true });

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		const storage = await openNodeSqliteStorage(location.database);
		harness = await Harness.open(
			storage,
			{
				models: modelRuntime,
				registry: extensions,
				settings,
				env: envs.env,
				onReport: (error) => report(error),
			},
			context,
		);
		const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime) : undefined;
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});
		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);
		let current: Conversation = root;
		conversation = await root.viewState(context);
		const models = (): ModelSummary[] =>
			modelRuntime.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			}));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};
		let notifying = false;
		// Commit listeners and Chord frames call this on the Session line; rendering runs afterwards, once per burst.
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
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		// Hindsight is optional: a disabled or broken backend must not stop the host. Bind only
		// after open, then route submits through it so placed inputs carry a context admission.
		if (hindsight !== undefined) {
			try {
				await hindsight.bind({ session: opened, storage, directory: location.directory, context });
				hindsightBound = true;
			} catch {
				await hindsight?.close().catch(() => {});
				hindsight = undefined;
				Object.defineProperty(registry, HINDSIGHT_CONTROLLER, { value: undefined, configurable: true });
				report(new Error("Hindsight binding failed; memory unavailable"));
			}
		}
		let showMcpStatus = true;
		const mcpStatusIds: number[] = [];
		const clearMcpStatus = (): void => {
			if (mcpStatusIds.length === 0) return;
			const ids = new Set(mcpStatusIds);
			update({ notices: state.notices.filter((item) => !ids.has(item.id)) });
			mcpStatusIds.length = 0;
		};
		const mcpNotice = (level: Notice["level"], message: string): void => {
			const id = nextNotice;
			notice(level, message);
			mcpStatusIds.push(id);
			if (mcpStatusIds.length > 20) mcpStatusIds.shift();
		};
		unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
		// Subagents appear as their conversations are created. A commit listener only records; it calls no Session API.
		unsubscribeCommits = harness.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
				} else if (change.type === "entry" && change.value.kind === "pi.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			if (closing) return Promise.reject(new Error("Durable runtime is closed."));
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined)
				throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		const controller: DurableController = {
			submit: (text, whenBusy) =>
				command(async () => {
					const input = text.trim();
					if (input === "/mcp off") {
						showMcpStatus = false;
						clearMcpStatus();
						return;
					}
					if (input === "/mcp on") showMcpStatus = true;
					if (input === "/mcp" || input === "/mcp on") {
						clearMcpStatus();
						if (!showMcpStatus) mcpNotice("info", "MCP status hidden; use /mcp on to show it.");
						else if (!mcp) mcpNotice("info", "MCP disabled (--no-mcp).");
						else if ("status" in mcp) {
							for (const server of mcp.status())
								mcpNotice(
									server.state === "connected" ? "info" : "warning",
									`MCP ${server.server}: ${server.state} (${server.tools} tools)`,
								);
						} else mcpNotice("info", "One explicitly selected MCP server is connected.");
						return;
					}
					const submission =
						hindsight !== undefined && hindsightBound
							? await hindsight.submit(current, text, whenBusy)
							: await current.submit({ type: "input", content: text, whenBusy }, context);
					watchAnswer(submission);
				}),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					// Report the outcome once it is known; the status line shows the compaction meanwhile.
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							// A summary written while busy is a submission: placed now, queued, or dropped as stale.
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else
							notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			reload: (path) =>
				command(async () => {
					const wasBound = hindsightBound;
					hindsightBound = false;
					let count: number;
					try {
						count = await extensions.reloadWhenIdle(opened, context, path);
					} catch (error) {
						// A rejected candidate did not replace the published registry.
						hindsightBound = wasBound && !closing;
						throw error;
					}
					const published = hindsightOf(extensions);
					if (published === hindsight) {
						hindsightBound = wasBound && !closing;
					} else {
						const retired = hindsight;
						hindsight = undefined;
						Object.defineProperty(registry, HINDSIGHT_CONTROLLER, { value: undefined, configurable: true });
						if (retired !== undefined) {
							try {
								await retired.drain();
							} catch {
								report(new Error("Hindsight retirement drain failed; pending delivery remains durable"));
							} finally {
								await retired.close().catch(() => report(new Error("Hindsight retirement close failed")));
							}
						}
						if (published !== undefined) {
							hindsight = published;
							Object.defineProperty(registry, HINDSIGHT_CONTROLLER, { value: published, configurable: true });
							try {
								await published.bind({ session: opened, storage, directory: location.directory, context });
								hindsightBound = !closing;
							} catch {
								await published.close().catch(() => {});
								hindsight = undefined;
								Object.defineProperty(registry, HINDSIGHT_CONTROLLER, { value: undefined, configurable: true });
								report(new Error("Hindsight binding failed; memory unavailable"));
							}
						}
					}
					notice("info", `Reloaded ${count} Durable extension(s). Session preserved.`);
				}),
			// Not queued: it waits until the conversation is idle.
			abort: () => {
				if (closing) return Promise.reject(new Error("Durable runtime is closed."));
				return current.abort(context).catch(fail);
			},
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}),
			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
				}),
			switchConversation: (id) =>
				command(async () => {
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation?.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		// The task panel starts open; /tasks hides it.
		await controller.toggleTasks();
		// Recovered work from an interrupted turn continues now.
		harness.resume();

		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			settings: settingsManager,
			harness: opened,
			modelRuntime,
			submitTo: async (id, text, whenBusy) => {
				if (closing) throw new Error("Durable runtime is closed.");
				const target = await opened.conversation(id, context);
				if (!target) throw new Error(`Conversation ${id} does not exist`);
				watchAnswer(hindsight !== undefined && hindsightBound
					? await hindsight.submit(target, text, whenBusy)
					: await target.submit({ type: "input", content: text, whenBusy }, context));
			},
			// Close writes no outcome: a running turn resumes with --continue.
			close: () => shutdown(),
		};
	} catch (error) {
		await shutdown([error]);
		throw error;
	}
}
