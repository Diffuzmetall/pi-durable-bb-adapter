import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession } from "./session.ts";

export class SessionRegistry {
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	private sessions = new Map<string, PiThreadSession>();

	constructor(sendNotification: (method: string, params: Record<string, unknown>) => void) {
		this.sendNotification = sendNotification;
	}

	public get(threadId: string): PiThreadSession | undefined {
		const session = this.sessions.get(threadId);
		if (session && session.runner?.exited) {
			this.sessions.delete(threadId);
			return undefined;
		}
		return session;
	}

	public async createOrGet(
		threadId: string,
		providerThreadId: string,
		params: any,
	): Promise<PiThreadSession> {
		const existing = this.sessions.get(threadId);
		if (existing && !existing.runner.exited) {
			return existing;
		}
		if (existing && existing.runner.exited) {
			this.sessions.delete(threadId);
		}

		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);

		// Shared Owner routing: check if an active session already exists for this sessionKey
		let sharedSession: PiThreadSession | undefined;
		for (const active of this.sessions.values()) {
			if (!active.runner?.exited && parseProviderThreadId(active.options.providerThreadId).sessionKey === sessionKey) {
				sharedSession = active;
				break;
			}
		}

		if (sharedSession) {
			this.sessions.set(threadId, sharedSession);
			sharedSession.registerThread?.(threadId, conversationId);
			this.sendNotification("thread/identity", {
				threadId,
				providerThreadId,
				sessionRestorable: true,
			});
			this.sendNotification("thread/delta", {
				threadId,
				deltas: [{ kind: "session.reset" }],
			});
			return sharedSession;
		}

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

		const sessionDir = resolveSessionDir();
		const sessionFilePath = resolveSessionFilePath(sessionKey);
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
		);

		await session.start();
		session.registerThread?.(threadId, conversationId);
		this.sessions.set(threadId, session);

		// Send initial identity & reset boundary
		this.sendNotification("thread/identity", {
			threadId,
			providerThreadId,
			sessionRestorable: true,
		});
		this.sendNotification("thread/delta", {
			threadId,
			deltas: [{ kind: "session.reset" }],
		});

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

		// Workspace location changed, recreate session in new directory
		await session.closeGracefully();
		this.sessions.delete(threadId);

		const updatedParams = {
			...session.options,
			cwd: targetCwd,
		};
		return this.createOrGet(threadId, session.options.providerThreadId, updatedParams);
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (session) {
			session.unregisterThread?.(threadId);
			this.sessions.delete(threadId);
			const isStillShared = Array.from(this.sessions.values()).includes(session);
			if (!isStillShared) {
				await session.closeGracefully();
			}
		}
	}

	public async stopAll(): Promise<void> {
		const uniqueSessions = new Set(this.sessions.values());
		this.sessions.clear();
		for (const session of uniqueSessions) {
			await session.closeGracefully();
		}
	}
}
