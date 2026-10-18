import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession, type SessionNotifications } from "../../projection/host/session.ts";
import { operatorGrantConfig, readSelectedNativeSession, stableRootProviderId } from "../../bootstrap/provider-grant.ts";
import { dirname } from "node:path";
import { nativeRootFor } from "../../bootstrap/native-runtime.ts";
import { hasOperatorProfile } from "../../bootstrap/operator-profile.ts";
import { readPreparedRootProfile } from "../../bootstrap/operator-profile-attachment.ts";
import { rootAttachmentContextSchema, type RootAttachmentContext } from "../../bb-contracts/packages/host-daemon-contract/src/native-root-attachment.ts";

export class SessionRegistry {
	private sendNotification: SessionNotifications;
	// Captured at provider-process construction, never from per-thread options/envVars.
	private readonly ownerGrant = operatorGrantConfig();
	private sessions = new Map<string, { session: PiThreadSession; providerThreadId: string }>();
	private constructions = new Map<string, { providerThreadId: string; promise: Promise<PiThreadSession> }>();

	private readonly profileChoices = new Map<string, { present: boolean; context?: RootAttachmentContext; config?: ReturnType<typeof readPreparedRootProfile> }>();
	private profileChoice(threadId: string) {
		let choice = this.profileChoices.get(threadId);
		if (!choice) {
			choice = { present: this.operatorDataDir !== undefined && hasOperatorProfile(this.operatorDataDir, threadId) };
			this.profileChoices.set(threadId, choice); // Freeze absence too: active managed roots cannot be retargeted.
		}
		return choice;
	}

	constructor(sendNotification: SessionNotifications, private readonly operatorDataDir?: string) {
		this.sendNotification = sendNotification;
	}

	public get(threadId: string): PiThreadSession | undefined {
		const session = this.sessions.get(threadId)?.session;
		if (session && session.runner?.exited) {
			this.sessions.delete(threadId);
			return undefined;
		}
		return session;
	}

	public resolveProviderIdentity(threadId: string, requested?: string): string {
		const existing = this.sessions.get(threadId)?.providerThreadId ?? this.constructions.get(threadId)?.providerThreadId;
		if (existing && requested && existing !== requested) throw new Error("Provider identity conflict");
		return existing ?? requested ?? (this.operatorDataDir !== undefined || this.ownerGrant || this.profileChoice(threadId).present ? stableRootProviderId(threadId) : `pi_durable_${Date.now()}`);
	}

	public get observationEnabled(): boolean { return this.ownerGrant !== undefined; }
	public observationForThread(threadId: string): boolean {
		return this.operatorDataDir !== undefined || this.ownerGrant !== undefined || this.sessions.get(threadId)?.session.controlledObservation === true || this.profileChoice(threadId).present;
	}

	public assertObservationControl(threadId: string): void {
		const binding = this.sessions.get(threadId);
		if (!this.ownerGrant && !binding?.session.controlledObservation) return;
		if (!binding) throw new Error("BB_OWNER_SESSION_NOT_AUTHORIZED");
		if (parseProviderThreadId(binding.providerThreadId).conversationId !== undefined)
			throw new Error("BB_OWNER_CHILD_READ_ONLY");
	}

	public createOrGet(threadId: string, providerThreadId: string, params: any): Promise<PiThreadSession> {
		const pending = this.constructions.get(threadId);
		if (pending) {
			if (pending.providerThreadId !== providerThreadId) return Promise.reject(new Error("Provider identity conflict"));
			return pending.promise;
		}
		const promise = this.createSession(threadId, providerThreadId, params).finally(() => this.constructions.delete(threadId));
		this.constructions.set(threadId, { providerThreadId, promise });
		return promise;
	}

	private async createSession(
		threadId: string,
		providerThreadId: string,
		params: any,
	): Promise<PiThreadSession> {
		if (this.operatorDataDir !== undefined && !this.ownerGrant && !this.profileChoice(threadId).present
			&& !parseProviderThreadId(providerThreadId).sessionKey.startsWith("pi_durable_bb_"))
			throw new Error("NATIVE_LEGACY_SESSION_REQUIRES_EXPLICIT_MIGRATION: existing history is preserved, never silently replaced");
		if (params.bbRootAttachment !== undefined && !this.profileChoice(threadId).present)
			throw new Error("BB_OPERATOR_PROFILE_REQUIRED_FOR_ADMITTED_ROOT");
		const frozen = this.profileChoices.get(threadId)?.context;
		if (frozen && params.bbRootAttachment !== undefined && JSON.stringify(rootAttachmentContextSchema.parse(params.bbRootAttachment)) !== JSON.stringify(frozen))
			throw new Error("BB_OPERATOR_PROFILE_ADMISSION_CHANGED");
		const existing = this.sessions.get(threadId);
		if (existing && !existing.session.runner.exited) {
			if (existing.providerThreadId !== providerThreadId) throw new Error("Provider identity conflict");
			await existing.session.authorizeObservationThread(threadId, providerThreadId);
			await existing.session.observeThread(threadId, providerThreadId);
			return existing.session;
		}
		if (existing) this.sessions.delete(threadId);

		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);
		const choice = this.profileChoice(threadId);
		if (choice.present && (conversationId !== undefined || providerThreadId !== stableRootProviderId(threadId)))
			throw new Error("BB_OPERATOR_PROFILE_CORE_ROOT_REQUIRED");

		// Shared Owner routing: check if an active session already exists for this sessionKey
		let sharedSession: PiThreadSession | undefined;
		for (const { session: active } of this.sessions.values()) {
			const canOwnRoot = !active.controlledObservation || conversationId !== undefined || parseProviderThreadId(active.options.providerThreadId).conversationId === undefined;
			if (canOwnRoot && !active.runner?.exited && parseProviderThreadId(active.options.providerThreadId).sessionKey === sessionKey) {
				sharedSession = active;
				break;
			}
		}

		if (sharedSession) {
			await sharedSession.authorizeObservationThread(threadId, providerThreadId);
			this.sessions.set(threadId, { session: sharedSession, providerThreadId });
			sharedSession.registerThread?.(threadId, conversationId);
			this.sendNotification("thread/identity", {
				threadId,
				providerThreadId,
				sessionRestorable: true,
			});
			if (!sharedSession.controlledObservation || conversationId === undefined) this.sendNotification("thread/delta", {
				threadId,
				deltas: [{ kind: "session.reset" }],
			});
			await sharedSession.observeThread(threadId, providerThreadId);
			return sharedSession;
		}

		// A controlled child cannot silently become an ordinary managed session when its Root is detached.
		// This namespace only DENIES fallback; it never grants profile/native authority.
		// A child can reconnect to its existing native owner, but nativeRootFor never lets it launch/provision one.

		const rawModel = params.model ?? params.options?.model;
		let resolvedModel: { provider: string; id: string } | undefined;
		if (typeof rawModel === "string") {
			const parts = rawModel.split("/");
			if (parts.length >= 2) {
				resolvedModel = { provider: parts[0], id: parts.slice(1).join("/") };
			}
		} else if (rawModel && typeof rawModel === "object") {
			resolvedModel = rawModel;
		}

		const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
		const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;
		const providerOptions = params.options?.providerOptions ?? params.providerOptions;

		let ownerGrant = this.ownerGrant;
		if (choice.present) {
			if (ownerGrant) throw new Error("BB_OPERATOR_PROFILE_AMBIGUOUS_GLOBAL_CONFIG");
			if (params.bbRootAttachment === undefined) throw new Error("BB_OPERATOR_PROFILE_ROOT_ADMISSION_REQUIRED");
			choice.context ??= Object.freeze(rootAttachmentContextSchema.parse(params.bbRootAttachment));
			choice.config ??= readPreparedRootProfile(this.operatorDataDir!, threadId, choice.context);
			ownerGrant = (await choice.config).config;
		}
		let selectedNative;
		if (!ownerGrant && this.operatorDataDir !== undefined) {
			if (!this.sendNotification.getOwnerScope) throw new Error("NATIVE_ROOT_CORE_SCOPE_REQUIRED");
			const proof = await this.sendNotification.getOwnerScope(providerThreadId);
			if (proof.threadId !== threadId || proof.providerId !== "pi-durable" || proof.providerThreadId !== providerThreadId)
				throw new Error("NATIVE_ROOT_CORE_SCOPE_MISMATCH");
			const native = await nativeRootFor(this.operatorDataDir, proof, providerThreadId, params.cwd ?? process.cwd());
			ownerGrant = native.config;
			selectedNative = native.selected;
		}
		const sessionDir = resolveSessionDir();
		selectedNative ??= ownerGrant ? await readSelectedNativeSession(ownerGrant.descriptorPath) : undefined;
		const sessionFilePath = ownerGrant ? dirname(ownerGrant.descriptorPath) : resolveSessionFilePath(sessionKey);
		if (ownerGrant && rawEnv && Object.keys(rawEnv).some(key => /^(?:PI_DURABLE_|BB_PI_|NODE_|LD_|DYLD_)/.test(key))) {
			throw new Error("BB owner provisioning forbids per-thread runtime/owner environment overrides");
		}
		const extensionPath = requireExtensionPath();
		const scratchDir = requireScratchDir();

		const session = new PiThreadSession(
			{
				threadId,
				providerThreadId,
				cwd: params.cwd,
				sessionFilePath,
				sessionDir,
				extensionPath,
				scratchDir,
				model: resolvedModel,
				thinkingLevel: rawThinking,
				shellEnvOverrides: rawEnv,
				appendSystemPrompt: params.appendSystemPrompt,
				providerOptions,
			},
			this.sendNotification,
			ownerGrant && selectedNative ? { config: ownerGrant, selected: selectedNative,
				...(choice.present ? { attachment: { dataDir: this.operatorDataDir!, context: choice.context! } } : {}) } : undefined,
		);

		await session.start();
		session.registerThread?.(threadId, conversationId);
		this.sessions.set(threadId, { session, providerThreadId });

		// Send initial identity & reset boundary
		this.sendNotification("thread/identity", {
			threadId,
			providerThreadId,
			sessionRestorable: true,
		});
		if (!session.controlledObservation || conversationId === undefined) this.sendNotification("thread/delta", {
			threadId,
			deltas: [{ kind: "session.reset" }],
		});
		await session.observeThread(threadId, providerThreadId);

		return session;
	}

	public async reconcileCwd(threadId: string, targetCwd?: string): Promise<PiThreadSession | undefined> {
		const session = this.get(threadId);
		if (!session) {
			return undefined;
		}
		if (!targetCwd || session.options.cwd === targetCwd) {
			return session;
		}

		// Keep the BB binding identity, not the shared runner owner's root identity.
		const providerThreadId = this.sessions.get(threadId)!.providerThreadId;
		await session.closeGracefully();
		this.sessions.delete(threadId);

		const updatedParams = {
			...session.options,
			cwd: targetCwd,
		};
		return this.createOrGet(threadId, providerThreadId, updatedParams);
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId)?.session;
		if (session) {
			session.unregisterThread?.(threadId);
			this.sessions.delete(threadId);
			const isStillShared = Array.from(this.sessions.values()).some(binding => binding.session === session);
			if (!isStillShared) {
				await session.closeGracefully();
			}
		}
	}

	public async stopAll(): Promise<void> {
		const uniqueSessions = new Set(Array.from(this.sessions.values(), binding => binding.session));
		this.sessions.clear();
		for (const session of uniqueSessions) {
			await session.closeGracefully();
		}
	}
}
