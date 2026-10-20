import { createHash } from "node:crypto";
import { RunnerProcess, type RunnerProcessOptions } from "../../provider/host/runner-process.ts";
import { SharedHostClient } from "../../bootstrap/shared-host-client.ts";
import type { DurableView } from "../../provider/runner/runtime-types.ts";
import { publishRegistrationHandoff } from "../../bootstrap/registration-handoff.ts";
import { pairExistingChild, observeChild, controlChild } from "../../history/observation-client.ts";
import { openHistorySink, type HistoryRequester } from "../../history/history-sink.ts";
import { projectCoherentHistory } from "../../history/history-projector.ts";
import type { OwnerGrant } from "../../bootstrap/owner-grant.ts";
import type { DurableBinding } from "../../store/binding-store.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import {
	buildRunnerArgs,
	createReadyDeferred,
	waitForReady,
	extractSessionStats,
	createContextWindowDelta,
	type SessionStats,
} from "../../provider/host/session-telemetry.ts";
import { SubagentMirrorManager, type SubagentMirrorRecord } from "../../provider/host/subagent-mirror.ts";
import { spawnSubthreadInBb } from "./subthread-spawner.ts";
import { nativeChildKey, nativeChildRegistrationRequestId } from "./native-child-binding.ts";
import { NativeChildRegistrationServer, type NativeChildRegistrationReceipt, type NativeChildRegistrationRequest } from "./native-child-registration-server.ts";
import { parseProviderThreadId } from "../../provider/host/composite-id.ts";
import type { RegisterExistingRequest } from "./native-child-binding.ts";
import { PROVIDER_ID, type RunnerEvent, type SessionOptions } from "../../provider/host/types.ts";
import { produceProviderOwnerGrant, readSelectedNativeSession, verifyNativeReady, type OperatorGrantConfig, type ProviderOwnerScope, type SelectedNativeSession } from "../../bootstrap/provider-grant.ts";

export type { SubagentMirrorRecord };
import { readPreparedRootProfile } from "../../bootstrap/operator-profile-attachment.ts";
import type { RootAttachmentContext } from "../../bb-contracts/packages/host-daemon-contract/src/native-root-attachment.ts";

export type SessionNotifications = ((method: string, params: Record<string, unknown>) => void) & {
	registerExisting?: (request: RegisterExistingRequest) => Promise<{ threadId: string }>;
	getOwnerScope?: (providerThreadId: string) => Promise<ProviderOwnerScope>;
	confirmRootAttachment?: (request: { providerThreadId: string; enrollmentFingerprint: string; rootProfileFingerprint: string }) => Promise<{ threadId: string }>;
	reconcileExisting?: HistoryRequester;
};

export class PiThreadSession {
	public get controlledObservation(): boolean { return this.observationOwner !== undefined; }
	public options: SessionOptions;
	private sendNotification: SessionNotifications;
	public runner: Pick<RunnerProcess, "request" | "requestOk" | "kill" | "closeGracefully" | "exited">;
	public translator = new DeltaTranslator();
	public registerExisting?: (request: RegisterExistingRequest) => Promise<{ threadId: string }>;
	public readyPromise: Promise<void>;
	private readyResolve: () => void;
	private readyReject: (err: Error) => void;
	public isProcessing = false;
	private lastCheckpointId: string | null = null;
	private conversationThreadMap = new Map<string, string>();
	private threadConversationMap = new Map<string, string>();
	private mirrors = new SubagentMirrorManager();
	private childTranslators = new Map<string, DeltaTranslator>();
	private nativeChildRegistrations = new Map<string, { requestId: string; promise?: Promise<{ threadId: string }> }>();
	private nativeChildRegistrationServer: NativeChildRegistrationServer;
	private modelConfigured = false;
	private modelConfiguration?: Promise<void>;
	private readyView: unknown;
	private rootRunOpen = false;
	private recoveredCheckpoint?: string;
	private pendingRootInput?: { afterEntryId: number; text: string };
	private observationAuthorized = false;
	private observationGrant?: OwnerGrant;
	private observationsEnabled = false;
	private closed = false;
	private readonly observationLifetime = new AbortController();
	private latestConversationIds: readonly number[] = [];
	private readonly nativeDiscovery = new Map<number, Promise<void>>();
	private readonly observationHandles = new Map<string, {
		abort: AbortController; ended: boolean; ready?: Promise<void>; handle?: { close(): Promise<void> };
	}>();
	private readonly observationOwner?: { config: OperatorGrantConfig; selected: SelectedNativeSession; attachment?: { dataDir: string; context: RootAttachmentContext } };

	constructor(
		options: SessionOptions,
		sendNotification: SessionNotifications,
		observationOwner?: { config: OperatorGrantConfig; selected: SelectedNativeSession; attachment?: { dataDir: string; context: RootAttachmentContext } },
	) {
		this.options = options;
		this.observationOwner = observationOwner;
		this.sendNotification = sendNotification;
		this.nativeChildRegistrationServer = new NativeChildRegistrationServer(
			options.scratchDir,
			(request) => this.registerNativeChild(request),
		);
		this.registerExisting = sendNotification.registerExisting
			? (request) => this.registerExistingDeduplicated(request)
			: undefined;

		const deferred = createReadyDeferred();
		this.readyPromise = deferred.promise;
		this.readyResolve = deferred.resolve;
		this.readyReject = deferred.reject;

		const callbacks: Pick<RunnerProcessOptions, "onEvent" | "onChannelMessage" | "onError" | "onExit"> = {
			onEvent: (event) => {
				if (this.observationOwner && !this.observationAuthorized) return;
				return this.handleRunnerEvent(event);
			},
			onChannelMessage: (msg: unknown) => {
				if (msg && typeof msg === "object" && "kind" in msg && msg.kind === "ready") {
					this.readyView ??= msg;
					this.readyResolve();
				}
			},
			onError: (err) => {
				this.detachObservations();
				this.observationAuthorized = false;
				this.readyReject(new Error(`Runner failed to launch: ${err.message}`));
				void this.nativeChildRegistrationServer.close().catch((error) => console.warn(`[PiThreadSession] Registration socket cleanup failed: ${error}`));
			},
			onExit: (code, sig) => {
				this.detachObservations();
				this.observationAuthorized = false;
				this.readyReject(new Error(`Runner exited before becoming ready (code ${code}, signal ${sig})`));
				void this.nativeChildRegistrationServer.close().catch((error) => console.warn(`[PiThreadSession] Registration socket cleanup failed: ${error}`));
			},
		};
		this.runner = observationOwner
			? new SharedHostClient(observationOwner.selected.socket, options.cwd || process.cwd(), callbacks, ids => {
				if (this.closed) return;
				this.latestConversationIds = ids;
				// Capture early, but never pair/register/observe before actual authorization.
				if (this.observationAuthorized && this.observationsEnabled && parseProviderThreadId(this.options.providerThreadId).conversationId === undefined)
					void this.observeThread(this.options.threadId, this.options.providerThreadId, false);
			}, {
				onDisconnect: (error) => {
					this.observationAuthorized = false;
					this.pauseObservations();
					console.warn(`[PiThreadSession] Native transport disconnected (${error.message}); reattaching without command replay`);
				},
				onReconnect: async (view) => {
					this.readyView = { kind: "ready", sharedHost: true, session: view.session };
					await this.authorizeObservationThread(this.options.threadId, this.options.providerThreadId);
					if (this.closed) return;
					this.observationAuthorized = true;
					await this.recoverRootSnapshot(view);
					await this.observeThread(this.options.threadId, this.options.providerThreadId);
				},
			})
			: new RunnerProcess({
				cwd: options.cwd || process.cwd(),
				args: buildRunnerArgs({ ...options, model: undefined, thinkingLevel: undefined }),
				env: { ...options.shellEnvOverrides, PI_DURABLE_NATIVE_CHILD_REGISTRATION_SOCKET: this.nativeChildRegistrationServer.socketPath },
				...callbacks,
			});
	}

	public registerThread(threadId: string, conversationId?: string): void {
		if (conversationId !== undefined && conversationId !== null && String(conversationId).trim() !== "") {
			const key = String(conversationId);
			this.conversationThreadMap.set(key, threadId);
			this.threadConversationMap.set(threadId, key);
		}
	}

	public unregisterThread(threadId: string): void {
		const observation = this.observationHandles.get(threadId);
		if (observation) {
			observation.abort.abort();
			void observation.handle?.close();
			this.observationHandles.delete(threadId);
		}
		const key = this.threadConversationMap.get(threadId);
		if (key !== undefined) {
			this.conversationThreadMap.delete(key);
			this.threadConversationMap.delete(threadId);
			this.childTranslators.delete(threadId);
		}
	}

	private getChildTranslator(threadId: string): DeltaTranslator {
		let t = this.childTranslators.get(threadId);
		if (!t) {
			t = new DeltaTranslator();
			this.childTranslators.set(threadId, t);
		}
		return t;
	}

	public getThreadIdForConversation(conversationId: string | number): string | undefined {
		return this.conversationThreadMap.get(String(conversationId));
	}

	public markSubagentActive(id: string | number, meta: { task: string; parentToolCallId?: string }): void {
		this.mirrors.markActive(id, meta);
	}
	public markSubagentCompleted(id: string | number, result?: string): void { this.mirrors.markCompleted(id, result); }
	public consumeCompletedMirror(id: string | number): void { this.mirrors.consumeCompleted(id); }
	public findSubagentConversationForTask(task: string): string | undefined { return this.mirrors.findConversationForTask(task); }
	public getSubagentState(id: string | number): SubagentMirrorRecord | undefined { return this.mirrors.getState(id); }

	public async start(): Promise<void> {
		try {
			await Promise.all([waitForReady(this.readyPromise), this.nativeChildRegistrationServer.ready]);
			if (this.observationOwner) {
				await this.authorizeObservationThread(this.options.threadId, this.options.providerThreadId);
				this.observationAuthorized = true;
			}
			// Controlled attach is READ-ONLY and preserves the native model. The
			// ordinary managed route retains its exact eager selection/ACK guard.
			if (!this.options.noSession && !this.observationOwner) await this.configureSelectedModel();
			if (!this.observationOwner || parseProviderThreadId(this.options.providerThreadId).conversationId === undefined)
				await this.refreshContextUsage(); // Never emit even context-window child deltas on controlled read attach.
		} catch (err) {
			this.kill();
			throw err;
		}
	}

	public async authorizeObservationThread(threadId: string, providerThreadId: string): Promise<void> {
		if (!this.observationOwner) return;
		const child = parseProviderThreadId(providerThreadId).conversationId;
		if (child !== undefined && (!Number.isSafeInteger(Number(child)) || Number(child) <= 0)) throw new Error("BB_OWNER_INVALID_CHILD_ID");
		// Recheck the captured actual native identity before every authority request,
		// including NCR duplicates on an already-started provider root.
		const state: unknown = await this.runner.requestOk({ type: "get_state" });
		const current = await readSelectedNativeSession(this.observationOwner.config.descriptorPath);
		if (JSON.stringify(current) !== JSON.stringify(this.observationOwner.selected)) throw new Error("BB_OWNER_NATIVE_DESCRIPTOR_CHANGED");
		await verifyNativeReady(current, this.readyView, state, this.options.cwd);
		const attachment = this.observationOwner.attachment;
		if (attachment && child === undefined) {
			const prepared = await readPreparedRootProfile(attachment.dataDir, threadId, attachment.context);
			if (JSON.stringify(prepared.config) !== JSON.stringify(this.observationOwner.config) || JSON.stringify(prepared.selected) !== JSON.stringify(current))
				throw new Error("BB_OPERATOR_PROFILE_LIFETIME_CHANGED");
			if (!this.sendNotification.confirmRootAttachment) throw new Error("BB_OPERATOR_ROOT_CONFIRMATION_UNAVAILABLE");
			const confirmed = await this.sendNotification.confirmRootAttachment({ providerThreadId,
				enrollmentFingerprint: prepared.admission.enrollmentFingerprint, rootProfileFingerprint: prepared.admission.rootProfileFingerprint });
			if (confirmed.threadId !== threadId) throw new Error("BB_OPERATOR_ROOT_CONFIRMATION_MISMATCH");
		} // Actual Core confirmation/current identity ACK, never a profile or passed tuple alone.
		if (!this.sendNotification.getOwnerScope) throw new Error("BB_OWNER_RPC_UNAVAILABLE");
		const proof = await this.sendNotification.getOwnerScope(providerThreadId);
		this.observationGrant = await produceProviderOwnerGrant({ config: this.observationOwner.config, proof,
			expected: { providerId: PROVIDER_ID, threadId, providerThreadId }, childConversationId: child });
		if (child === undefined) {
			await publishRegistrationHandoff({ grantPath: this.observationOwner.config.grantPath, proof,
				expected: { providerId: PROVIDER_ID, threadId, providerThreadId },
				socketPath: this.nativeChildRegistrationServer.socketPath, nativeSession: current.session });
		} // Child aliases can consume the parent grant, never publish its NCR locator.
	}

	private async handleRunnerEvent(event: RunnerEvent) {
		// Coherent observation is the SOLE standalone child transcript writer.
		// A child-only client must not translate unscoped ROOT stream events either.
		if (this.observationOwner && (parseProviderThreadId(this.options.providerThreadId).conversationId !== undefined ||
			(event.conversationId !== undefined && event.conversationId !== null))) return;
		if (event.type === "agent_start" || event.type === "turn_start") {
			this.rootRunOpen = true;
			this.recoveredCheckpoint = undefined;
		}
		if (this.recoveredCheckpoint && !this.rootRunOpen &&
			["message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) return;
		if (event.type === "agent_end") {
			if (this.recoveredCheckpoint && event.providerCheckpointId === this.recoveredCheckpoint) return;
			this.rootRunOpen = false;
			this.pendingRootInput = undefined;
		}
		if (typeof event.providerCheckpointId === "string" && event.providerCheckpointId.length > 0) {
			this.lastCheckpointId = event.providerCheckpointId;
		}

		if (event.type === "agent_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed before agent_end: ${err}`);
			}
		}

		if (event.type === "tool_execution_update" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined) {
				const task = typeof details.task === "string" ? details.task : "";
				const title = typeof details.title === "string" && details.title.trim() ? details.title.trim() : undefined;
				const parentToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				const convId = String(details.conversationId);
				const isNew = !this.getSubagentState(convId) && this.getThreadIdForConversation(convId) === undefined;
				const sessionId = parseProviderThreadId(this.options.providerThreadId).sessionKey;
				const requestId = typeof details.requestId === "string" && details.requestId.trim() && details.requestId.length <= 200
					? details.requestId
					: nativeChildRegistrationRequestId({ providerId: PROVIDER_ID, sessionId, conversationId: convId,
						parentProviderThreadId: this.options.providerThreadId });
				this.markSubagentActive(convId, { task, parentToolCallId });
				if (this.observationOwner) {
					const id = Number(convId);
					if (this.observationsEnabled && Number.isSafeInteger(id) && id > 0)
						void this.observeLocatedChild(id).catch(() => this.historyDiagnostic("BB_NATIVE_PAIR_UNCERTAIN", id));
				} else if (isNew) {
					void spawnSubthreadInBb({
						providerId: PROVIDER_ID,
						sessionId,
						parentProviderThreadId: this.options.providerThreadId,
						parentThreadId: this.options.threadId,
						...(title ? { title } : {}),
						conversationId: convId,
						requestId,
					}, this, {
						owner: {
							providerId: PROVIDER_ID,
							sessionId,
							parentProviderThreadId: this.options.providerThreadId,
							parentThreadId: this.options.threadId,
						},
					}).then((projection) => {
						if (projection.status !== "projection-unavailable" || !parentToolCallId) return;
						const message = projection.reason === "unsupported-registration-port"
							? "BB child registration is unavailable; no BB child thread was created. Durable work continues."
							: projection.reason === "registration-unconfirmed"
								? "BB child registration outcome is unconfirmed; the Durable child was not resubmitted."
								: `BB child registration refused (${projection.reason}); the Durable child was not resubmitted.`;
						this.sendNotification("thread/delta", {
							threadId: this.options.threadId,
							deltas: [{
								kind: "item.progress",
								key: { providerItemId: parentToolCallId },
								message,
							}],
						});
					}).catch((error: unknown) => {
						console.warn(`[PiThreadSession] Native child projection reporting failed: ${error}`);
					});
				}
			}
		}

		if (event.type === "tool_execution_end" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined) {
				const result = typeof event.result === "string" ? event.result : undefined;
				this.markSubagentCompleted(details.conversationId as string | number, result);
			}
		}

		const isChildEvent = event.conversationId !== undefined && event.conversationId !== null;
		const childThreadId = isChildEvent
			? this.getThreadIdForConversation(event.conversationId as string | number)
			: undefined;

		if (childThreadId) {
			const childEvent = { ...event, parentRef: undefined, parentToolCallId: undefined };
			const childTranslator = this.getChildTranslator(childThreadId);
			const childContext = {
				threadId: childThreadId,
				cwd: this.options.cwd,
				providerOptions: this.options.providerOptions,
			};
			// The runner suppresses child lifecycle starts for the nested parent card.
			// A standalone child needs its own turn or BB drops its text deltas.
			const childDeltas = event.type === "agent_end" ? [] : childTranslator.translate({ type: "turn_start" }, childContext);
			childDeltas.push(...childTranslator.translate(childEvent, childContext));
			if (childDeltas.length > 0) {
				this.sendNotification("thread/delta", { threadId: childThreadId, deltas: childDeltas });
			}
			if (event.type === "agent_end") {
				this.markSubagentCompleted(event.conversationId as string | number);
			}
		} else if (isChildEvent && event.type === "agent_end") {
			this.markSubagentCompleted(event.conversationId as string | number);
		}

		if (isChildEvent && event.type === "agent_end") {
			return;
		}

		const parentDeltas = this.translator.translate(event, {
			threadId: this.options.threadId,
			ownsTurn: !isChildEvent,
			cwd: this.options.cwd,
			providerOptions: this.options.providerOptions,
		});
		if (parentDeltas.length > 0) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: parentDeltas });
		}

		if (event.type === "turn_end" || event.type === "compaction_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed after ${event.type}: ${err}`);
			}
		}
	}

	private controlledChildBinding(conversationId?: string, threadId?: string): DurableBinding | undefined {
		if (!this.observationOwner) return undefined;
		const ownChild = parseProviderThreadId(this.options.providerThreadId).conversationId;
		if (ownChild !== undefined && conversationId !== undefined && ownChild !== conversationId) throw new Error('BB_OWNER_CHILD_SCOPE_MISMATCH');
		const child = conversationId ?? ownChild;
		if (child === undefined) return undefined;
		const alias = threadId ?? this.getThreadIdForConversation(child);
		if (!alias || this.getThreadIdForConversation(child) !== alias || !this.observationGrant) throw new Error('BB_OWNER_CHILD_SCOPE_UNCONFIRMED');
		return { ...this.observationGrant.ownerScope, conversationId: Number(child) as DurableBinding['conversationId'], bbThreadId: alias };
	}

	public async prompt(text: string, conversationId?: string, clientRequestId?: string, threadId?: string): Promise<void> {
		await this.prepareControlledExecution(conversationId, threadId);
		const child = this.controlledChildBinding(conversationId, threadId);
		if (child) {
			if (!clientRequestId) throw new Error('BB_OWNER_CHILD_REQUEST_ID_REQUIRED');
			await controlChild({ socketPath: this.observationGrant!.socketPath, binding: child,
				command: { type: 'prompt', message: text, requestId: `bb-child:${clientRequestId}` } });
			return;
		}
		this.isProcessing = true;
		try {
			if (this.runner instanceof SharedHostClient) {
				const conversation = this.runner.view?.conversation;
				if (conversation?.conversation?.id !== 1) throw new Error("BB_OWNER_ROOT_SNAPSHOT_UNAVAILABLE");
				this.pendingRootInput = { afterEntryId: Number(conversation.entries.at(-1)?.id ?? 0), text };
			}
			await this.runner.requestOk({ type: "prompt", message: text, streamingBehavior: "followUp", conversationId });
		} finally {
			this.isProcessing = false;
		}
	}

	public async steer(text: string, conversationId?: string, clientRequestId?: string, threadId?: string): Promise<void> {
		await this.prepareControlledExecution(conversationId, threadId);
		const child = this.controlledChildBinding(conversationId, threadId);
		if (child) {
			if (!clientRequestId) throw new Error('BB_OWNER_CHILD_REQUEST_ID_REQUIRED');
			await controlChild({ socketPath: this.observationGrant!.socketPath, binding: child,
				command: { type: 'steer', message: text, requestId: `bb-child:${clientRequestId}` } });
			return;
		}
		await this.runner.requestOk({ type: "steer", message: text, conversationId });
	}

	public async abort(conversationId?: string, threadId?: string): Promise<void> {
		await this.assertControlledRootAuthority(conversationId, threadId); // NEVER configure merely to stop/detach.
		const child = this.controlledChildBinding(conversationId, threadId);
		if (child) {
			await controlChild({ socketPath: this.observationGrant!.socketPath, binding: child, command: { type: 'abort' } });
			return;
		}
		try {
			await this.runner.requestOk({ type: "abort", conversationId });
		} catch (err) {
			console.warn(`[PiThreadSession] Abort request failed: ${err}`);
		}
	}

	public async compact(instructions?: string): Promise<void> {
		if (this.observationOwner) await this.prepareControlledExecution();
		this.isProcessing = true;
		try {
			await this.runner.requestOk({ type: "compact", instructions });
		} finally {
			this.isProcessing = false;
		}
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		const delta = createContextWindowDelta(stats);
		if (delta) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: [delta] });
		}
	}

	public async assertControlledRootAuthority(conversationId?: string, threadId?: string): Promise<void> {
		if (!this.observationOwner) return;
		if (this.runner instanceof SharedHostClient) await this.runner.whenConnected();
		if (!this.observationAuthorized || this.closed) throw new Error("BB_OWNER_SCOPE_UNCONFIRMED");
		const child = this.controlledChildBinding(conversationId, threadId);
		await this.authorizeObservationThread(child?.bbThreadId ?? this.options.threadId,
			child ? `${child.sessionId}:${child.conversationId}` : this.options.providerThreadId);
		if (!this.observationAuthorized || this.closed) throw new Error("BB_OWNER_SCOPE_UNCONFIRMED");
	}

	public async prepareControlledExecution(conversationId?: string, threadId?: string): Promise<void> {
		if (this.observationOwner) {
			await this.assertControlledRootAuthority(conversationId, threadId);
			if (this.controlledChildBinding(conversationId, threadId)) return; // Retain native child's model/tools.
			if (!this.modelConfigured) {
				this.modelConfiguration ??= this.configureSelectedModel().finally(() => { this.modelConfiguration = undefined; });
				await this.modelConfiguration;
			}
		}
		this.assertModelConfigured(); // Ordinary managed behavior unchanged; never stamp merely to observe.
	}

	private async configureSelectedModel(): Promise<void> {
		const selected = this.options.model;
		const thinkingLevel = this.options.thinkingLevel;
		if (!selected?.provider || !selected.id || !thinkingLevel?.trim()) {
			throw new Error("BB model and thinking selections are required for a Durable session");
		}

		const catalog = await this.runner.requestOk({ type: "get_available_models" }) as { models?: unknown };
		const models = catalog?.models;
		const selectedIsAvailable = Array.isArray(models) && models.some((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const model = entry as Record<string, unknown>;
			return model.provider === selected.provider &&
				(model.modelId === selected.id || model.id === selected.id);
		});
		if (!selectedIsAvailable) {
			throw new Error("BB-selected model is not available in the Durable host");
		}

		await this.runner.requestOk({ type: "set_model", provider: selected.provider, modelId: selected.id });
		await this.runner.requestOk({ type: "set_thinking_level", level: thinkingLevel });
		const state = await this.runner.requestOk({ type: "get_state" }) as {
			model?: { provider?: unknown; id?: unknown; modelId?: unknown } | null;
			thinkingLevel?: unknown;
		};
		const actualModelId = state?.model?.modelId ?? state?.model?.id;
		if (state?.model?.provider !== selected.provider || actualModelId !== selected.id || state.thinkingLevel !== thinkingLevel) {
			throw new Error("Durable host did not retain the BB-selected model and thinking level");
		}
		this.modelConfigured = true;
	}

	private assertModelConfigured(): void {
		if (this.options.noSession) {
			throw new Error("Catalog-only Durable runner cannot accept a prompt");
		}
		if (!this.modelConfigured) {
			throw new Error("Durable model configuration is unconfirmed; prompt was not submitted");
		}
	}

	private async registerNativeChild(request: NativeChildRegistrationRequest): Promise<NativeChildRegistrationReceipt> {
		if (this.observationOwner && !this.observationAuthorized) throw new Error("BB_OWNER_SCOPE_UNCONFIRMED");
		if (this.observationOwner && parseProviderThreadId(this.options.providerThreadId).conversationId !== undefined)
			throw new Error("BB_OWNER_CHILD_CANNOT_REGISTER");
		const sessionId = parseProviderThreadId(this.options.providerThreadId).sessionKey;
		const projection = await spawnSubthreadInBb({
			providerId: PROVIDER_ID,
			sessionId,
			conversationId: String(request.conversationId),
			requestId: request.requestId,
			parentProviderThreadId: this.options.providerThreadId,
			parentThreadId: this.options.threadId,
			...(request.title ? { title: request.title } : {}),
		}, this, {
			owner: {
				providerId: PROVIDER_ID,
				sessionId,
				parentProviderThreadId: this.options.providerThreadId,
				parentThreadId: this.options.threadId,
			},
		});
		if (projection.status !== "registered") throw new Error(`Native child registration failed: ${projection.reason}`);
		return {
			requestId: request.requestId,
			conversationId: request.conversationId,
			providerId: PROVIDER_ID,
			sessionId,
			parentThreadId: this.options.threadId,
			threadId: projection.binding.bbThreadId,
		};
	}

	private async registerExistingDeduplicated(request: RegisterExistingRequest): Promise<{ threadId: string }> {
		if (this.observationOwner && !this.observationAuthorized) return Promise.reject(new Error("BB_OWNER_SCOPE_UNCONFIRMED"));
		if (this.observationOwner && parseProviderThreadId(this.options.providerThreadId).conversationId !== undefined)
			return Promise.reject(new Error("BB_OWNER_CHILD_CANNOT_REGISTER"));
		const sessionId = parseProviderThreadId(this.options.providerThreadId).sessionKey;
		if (typeof request.requestId !== "string" || !request.requestId.trim() || request.requestId.length > 200 ||
			request.sessionId !== sessionId || request.parentProviderThreadId !== this.options.providerThreadId ||
			(request.providerId !== undefined && request.providerId !== PROVIDER_ID) ||
			(request.parentThreadId !== undefined && request.parentThreadId !== this.options.threadId)) {
			return Promise.reject(new Error("Native child registration owner mismatch"));
		}
		if (this.observationOwner) {
			await this.authorizeObservationThread(this.options.threadId, this.options.providerThreadId);
			if (!this.observationAuthorized) throw new Error("BB_OWNER_SCOPE_UNCONFIRMED");
		}
		// NCR returns the real Core receipt only. Native owner persists its binding
		// AFTER this response; never open observation or await native put here.
		const key = nativeChildKey({ providerId: PROVIDER_ID, sessionId, conversationId: request.conversationId });
		let entry = this.nativeChildRegistrations.get(key);
		if (!entry) {
			entry = { requestId: request.requestId };
			this.nativeChildRegistrations.set(key, entry);
		}
		if (!entry.promise) {
			const canonicalRequest: RegisterExistingRequest = {
				// Native task IDs repeat in each Durable session; Core keys registrations per host.
				requestId: `pi-durable:native:${createHash("sha256").update(JSON.stringify([
					sessionId, this.options.providerThreadId, request.conversationId, entry.requestId,
				])).digest("hex")}`,
				sessionId,
				conversationId: request.conversationId,
				parentProviderThreadId: this.options.providerThreadId,
				providerId: PROVIDER_ID,
				parentThreadId: this.options.threadId,
				...(typeof request.title === "string" && request.title.trim() ? { title: request.title.trim() } : {}),
			};
			const promise = Promise.resolve().then(() => {
				if (!this.sendNotification.registerExisting) throw new Error("Native child registration port unavailable");
				return this.sendNotification.registerExisting(canonicalRequest);
			});
			entry.promise = promise;
			void promise.catch(() => {
				if (this.nativeChildRegistrations.get(key) === entry && entry.promise === promise) entry.promise = undefined;
			});
		}
		return entry.promise;
	}

	private historyDiagnostic(code: string, conversationId: number, threadId?: string): void {
		if (!this.closed) console.warn("[BB observation]", JSON.stringify({ code, conversationId, ...(threadId ? { threadId } : {}) }));
	}

	/** Existing registry lifecycle calls this AFTER actual root/child authorization.
	 * Numeric IDs are locators only; native pairer proves ownership before NCR.
	 * Explicit reconnect may retry an IDENTICAL uncertain pair, never implicitly.
	 */
	public async observeThread(threadId: string, providerThreadId: string, explicit = true): Promise<void> {
		if (!this.observationOwner || !this.observationAuthorized || this.closed) return;
		this.observationsEnabled = true;
		const child = parseProviderThreadId(providerThreadId).conversationId;
		if (child !== undefined) {
			// Existing Core-authorized BB alias: native observe independently checks
			// its persisted binding. No child promotion/NCR publication/hidden pair.
			const grant = this.observationGrant!;
			await this.openChildObservation({ ...grant.ownerScope, conversationId: Number(child) as DurableBinding["conversationId"], bbThreadId: threadId });
			return;
		}
		for (const id of this.latestConversationIds) {
			if (this.closed) return;
			const bb = this.getThreadIdForConversation(id);
			if (bb && this.observationHandles.get(bb)?.ended === false) continue;
			if (explicit) this.nativeDiscovery.delete(id);
			try { await this.observeLocatedChild(id); }
			catch { this.historyDiagnostic("BB_NATIVE_PAIR_UNCERTAIN", id); }
		}
	}

	private observeLocatedChild(id: number): Promise<void> {
		const previous = this.nativeDiscovery.get(id);
		if (previous) return previous;
		if (!Number.isSafeInteger(id) || id <= 0 || this.closed || !this.observationAuthorized || !this.observationsEnabled || !this.observationGrant ||
			parseProviderThreadId(this.options.providerThreadId).conversationId !== undefined || this.nativeDiscovery.size >= 256)
			return Promise.reject(new Error("BB_NATIVE_PAIR_UNAVAILABLE"));
		const grant = this.observationGrant;
		const pending = (async () => {
			const binding = await pairExistingChild({ socketPath: grant.socketPath, conversationId: id as DurableBinding["conversationId"],
				ownerScope: grant.ownerScope, signal: this.observationLifetime.signal });
			this.observationLifetime.signal.throwIfAborted();
			this.registerThread(binding.bbThreadId, String(id));
			await this.openChildObservation(binding); // paired ACK+EOF precedes digest/capture.
		})();
		this.nativeDiscovery.set(id, pending); // Retain failed attempt: NO automatic retry.
		return pending;
	}

	private openChildObservation(binding: DurableBinding): Promise<void> {
		const previous = this.observationHandles.get(binding.bbThreadId);
		if (previous && !previous.ended) return previous.ready!;
		if (!this.observationGrant || !this.sendNotification.reconcileExisting || this.closed || this.observationHandles.size >= 256)
			return Promise.reject(new Error("BB_CHILD_HISTORY_UNAVAILABLE"));
		const entry: { abort: AbortController; ended: boolean; ready?: Promise<void>; handle?: { close(): Promise<void> } } = {
			abort: new AbortController(), ended: false,
		};
		this.observationHandles.set(binding.bbThreadId, entry);
		const signal = AbortSignal.any([entry.abort.signal, this.observationLifetime.signal]);
		const grant = this.observationGrant;
		entry.ready = (async () => {
			try {
				const providerThreadId = `${binding.sessionId}:${binding.conversationId}`;
				this.sendNotification("thread/identity", { threadId: binding.bbThreadId, providerThreadId, sessionRestorable: true });
				await this.authorizeObservationThread(binding.bbThreadId, providerThreadId);
				signal.throwIfAborted();
				// This authorized digest read MUST precede native observation/capture.
				const sink = await openHistorySink({ threadId: binding.bbThreadId, request: this.sendNotification.reconcileExisting! });
				signal.throwIfAborted();
				entry.handle = await observeChild({ socketPath: grant.socketPath, binding, signal,
					onSnapshot: async () => {}, onEvents: async () => {}, // NEVER legacy/live transcript callbacks.
					onOutcome: async frame => {
						if (signal.aborted || this.closed) return;
						if (frame.status === "unknown" || (frame.status === "working" && !frame.entries)) {
							this.historyDiagnostic("BB_CHILD_OUTCOME_NOT_TERMINAL", binding.conversationId, binding.bbThreadId); return;
						}
						try {
							const projection = projectCoherentHistory(frame); // Native committed entries; never root/live translated callbacks.
							if (projection.omissions.length && !this.closed) console.warn("[BB history omissions]", JSON.stringify({
								threadId: binding.bbThreadId, stage: "projection", omissions: projection.omissions,
							})); // Account even if ACK is lost; NEVER thinking text/signatures or fabricated chat.
							await sink.apply(projection.snapshot);
						} catch {
							this.historyDiagnostic("BB_CHILD_HISTORY_UNSUPPORTED_OR_MIGRATION_REQUIRED", binding.conversationId, binding.bbThreadId);
							// A rejected/uncertain apply freezes this sink. End this observation;
							// only an explicit reconnect may capture fresh history after a digest read.
							throw new Error("BB_CHILD_HISTORY_REFUSED_OR_UNCONFIRMED");
						}
					},
					onEnd: reason => {
						entry.ended = true;
						if (reason === "refused" && !signal.aborted) this.historyDiagnostic("BB_CHILD_HISTORY_UNSUPPORTED_OR_MIGRATION_REQUIRED", binding.conversationId, binding.bbThreadId);
					},
				}); // Resolves INITIAL SNAPSHOT only, not terminal history success.
			} catch {
				entry.ended = true;
				if (!signal.aborted) this.historyDiagnostic("BB_CHILD_HISTORY_UNSUPPORTED_OR_MIGRATION_REQUIRED", binding.conversationId, binding.bbThreadId);
				throw new Error("BB_CHILD_HISTORY_UNAVAILABLE_OR_MIGRATION_REQUIRED");
			}
		})();
		return entry.ready;
	}

	private async recoverRootSnapshot(view: DurableView): Promise<void> {
		if (view.conversation?.conversation?.id !== 1 || parseProviderThreadId(this.options.providerThreadId).conversationId !== undefined) return;
		const live = view.conversation?.docs?.["pi.live"] as Record<string, unknown> | undefined;
		if (live?.run) {
			await this.handleRunnerEvent({ type: "turn_start" });
			return;
		}
		const inbox = view.conversation.docs["pi.inbox"];
		if (!inbox || !Array.isArray(inbox.items) || inbox.items.length) return;
		const pending = this.pendingRootInput;
		const entries = view.conversation.entries;
		const user = entries.findLast(entry => entry.kind === "pi.user");
		const userMessage = user?.model?.[0];
		const inputText = userMessage?.role === "user" ? (typeof userMessage.content === "string" ? userMessage.content :
			userMessage.content.filter(block => block.type === "text").map(block => block.text).join("")) : undefined;
		const inputCommitted = pending && user && Number(user.id) > pending.afterEntryId && inputText === pending.text;
		if ((!this.rootRunOpen && !inputCommitted) || !live || live.generation || live.compactionFailure ||
			["tools", "nestedTools", "compactions"].some(key => live[key] !== undefined && (!Array.isArray(live[key]) || live[key].length))) return;
		const tail = view.conversation.entries.at(-1);
		const message = tail?.kind === "pi.assistant" ? tail.model?.[0] : undefined;
		// Absence of a run is not success: require a committed terminal assistant entry.
		if (!tail || !message || message.role !== "assistant" || !["stop", "error", "aborted"].includes(message.stopReason)) return;
		if (!this.rootRunOpen && inputCommitted) await this.handleRunnerEvent({ type: "turn_start" });
		await this.handleRunnerEvent({ type: "message_end", message });
		await this.handleRunnerEvent({ type: "agent_end", messages: [message], providerCheckpointId: String(tail.id) });
		this.recoveredCheckpoint = String(tail.id);
	}

	private pauseObservations(): void {
		this.observationsEnabled = false;
		for (const entry of this.observationHandles.values()) { entry.abort.abort(); void entry.handle?.close(); }
		this.observationHandles.clear();
		this.nativeDiscovery.clear();
	}

	private detachObservations(): void {
		this.closed = true;
		this.observationLifetime.abort();
		this.pauseObservations();
	}

	public getLastCheckpointId(): string | null { return this.lastCheckpointId; }
	public async getSessionStats(): Promise<SessionStats> {
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return extractSessionStats(res);
	}
	public async closeGracefully(): Promise<void> {
		this.detachObservations();
		this.observationAuthorized = false;
		await this.runner.closeGracefully();
		await this.nativeChildRegistrationServer.close();
	}
	public kill(): void {
		this.detachObservations();
		this.observationAuthorized = false;
		this.runner.kill();
		void this.nativeChildRegistrationServer.close().catch((error) => console.warn(`[PiThreadSession] Registration socket cleanup failed: ${error}`));
	}
}
