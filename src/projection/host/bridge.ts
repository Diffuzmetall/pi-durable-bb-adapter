import { getSharedCatalog } from "../../provider/host/catalog.ts";
import { SessionRegistry } from "../../provider/host/session-registry.ts";
import { handleDiscoveryRequest } from "../../provider/host/discovery-handler.ts";
import { forkSessionDatabase } from "../../provider/host/thread-fork.ts";
import {
	sendJsonRpcResult,
	sendJsonRpcError,
	sendJsonRpcNotification,
} from "../../provider/host/jsonrpc.ts";
import {
	handleTurnStart,
	handleTurnSteer,
	handleThreadStop,
	type BridgeRouterContext,
	type TurnStartParams,
	type TurnSteerParams,
	type ThreadStopParams,
} from "../../provider/host/bridge-router.ts";
import type { RegisterExistingRequest } from "./native-child-binding.ts";
import { ownerScopeFrom, type ProviderOwnerScope } from "../../bootstrap/provider-grant.ts";
import type { HistoryRequester } from "../../history/history-sink.ts";
import { parseProviderThreadId } from "../../provider/host/composite-id.ts";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

function pendingKey(id: string | number): string {
	return `${typeof id}:${String(id)}`;
}

export class ProviderBridge {
	private sendRaw: (json: string) => void;
	private registry: SessionRegistry;
	private pendingRequests = new Map<string, PendingRequest>();
	private nextRequestId = 0;

	constructor(sendRaw: (json: string) => void, registry?: SessionRegistry, operatorDataDir?: string) {
		this.sendRaw = sendRaw;
		if (registry) {
			this.registry = registry;
		} else {
			const notify = (method: string, params: Record<string, unknown>) => this.sendNotification(method, params);
			Object.assign(notify, {
				registerExisting: (request: RegisterExistingRequest) => this.registerExisting(request),
				getOwnerScope: (providerThreadId: string) => this.getOwnerScope(providerThreadId),
				confirmRootAttachment: async (request: { providerThreadId: string; enrollmentFingerprint: string; rootProfileFingerprint: string }) => {
					const result = await this.reverseRequest("thread/confirmRootAttachment", request);
					if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("threadId" in result)
						|| typeof result.threadId !== "string" || !result.threadId.trim()) throw new Error("Invalid root confirmation acknowledgement");
					return { threadId: result.threadId };
				},
				reconcileExisting: (method: string, params: Parameters<HistoryRequester>[1]) => {
					if (method !== "thread/reconcileExisting") return Promise.reject(new Error("Unsupported historical request"));
					return this.reverseRequest(method, params);
				},
			});
			this.registry = new SessionRegistry(notify, operatorDataDir);
		}
	}

	public sendResult(id: string | number, result: Record<string, unknown>) {
		sendJsonRpcResult(this.sendRaw, id, result);
	}

	public sendError(id: string | number, code: number, message: string) {
		sendJsonRpcError(this.sendRaw, id, code, message);
	}

	public sendNotification(method: string, params: Record<string, unknown>) {
		sendJsonRpcNotification(this.sendRaw, method, params);
	}

	private async registerExisting(request: RegisterExistingRequest): Promise<{ threadId: string }> {
		const result = await this.reverseRequest("thread/registerExisting", request);
		if (!result || typeof result !== "object" || !("threadId" in result) || typeof result.threadId !== "string" || !result.threadId.trim())
			throw new Error("Native-thread registration returned an invalid response");
		return { threadId: result.threadId };
	}

	private async getOwnerScope(providerThreadId: string): Promise<ProviderOwnerScope> {
		// NEW explicit Core capability; unsupported responses fail closed, never fall back to a wire tuple.
		return ownerScopeFrom(await this.reverseRequest("thread/getOwnerScope", { providerThreadId }));
	}

	private reverseRequest(method: string, params: object): Promise<unknown> {
		const id = `bb1-register-existing-${++this.nextRequestId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(pendingKey(id));
				reject(new Error("Timed out waiting for authenticated native-thread registration"));
			}, 10_000);
			this.pendingRequests.set(pendingKey(id), { resolve, reject, timeout });
			this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	private handleResponse(response: {
		id: string | number;
		result?: unknown;
		error?: { message?: unknown };
	}): boolean {
		const key = pendingKey(response.id);
		const pending = this.pendingRequests.get(key);
		if (!pending) return false;
		this.pendingRequests.delete(key);
		clearTimeout(pending.timeout);
		if (response.error) {
			pending.reject(new Error(typeof response.error.message === "string" ? response.error.message : "Native-thread registration rejected"));
		} else {
			pending.resolve(response.result);
		}
		return true;
	}

	private async preflightControlled(threadId: string, supplied: unknown, execution: boolean, startParams?: Record<string, unknown>): Promise<void> {
		if (!this.registry.observationForThread(threadId)) return;
		const canonical = this.registry.resolveProviderIdentity(threadId, typeof supplied === "string" ? supplied : undefined);
		let session = this.registry.get(threadId);
		// Core may retry turn/start after thread/start failed before native admission.
		// Reuse the normal Core-authorized constructor, never a wire-owned fallback.
		if (!session && execution && startParams) session = await this.registry.createOrGet(threadId, canonical, startParams);
		if (!session) throw new Error("BB_OWNER_SESSION_NOT_AUTHORIZED");
		const target = parseProviderThreadId(canonical).conversationId;
		if (execution) await session.prepareControlledExecution(target);
		else await session.assertControlledRootAuthority(target);
	}

	private get routerContext(): BridgeRouterContext {
		return {
			registry: this.registry,
			sendNotification: (m, p) => this.sendNotification(m, p),
			sendResult: (i, r) => this.sendResult(i, r),
			sendError: (i, c, m) => this.sendError(i, c, m),
		};
	}

	public async handleLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) return;

		let req: {
			id?: string | number;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { message?: unknown };
		};
		try {
			req = JSON.parse(trimmed);
		} catch (err) {
			console.error(`[ProviderBridge] Invalid JSON received from daemon: ${trimmed}`, err);
			this.sendError(0, -32700, "Parse error: Invalid JSON");
			return;
		}

		if (req && typeof req.id !== "undefined" && typeof req.method !== "string") {
			this.handleResponse(req as { id: string | number; result?: unknown; error?: { message?: unknown } });
			return;
		}
		if (req && typeof req.method === "string") {
			await this.handleRequest({ id: req.id ?? 0, method: req.method, params: req.params });
		}
	}

	private async handleRequest(req: { id: string | number; method: string; params?: Record<string, unknown> }): Promise<void> {
		const { id, method, params = {} } = req;

		try {
			const catalogCwd = typeof params.cwd === "string" ? params.cwd : undefined;
			const discoveryResult = await handleDiscoveryRequest(method, params, getSharedCatalog(catalogCwd));
			if (discoveryResult !== null) {
				this.sendResult(id, discoveryResult);
				return;
			}

			switch (method) {
				case "thread/start":
				case "thread/resume": {
					const threadId = typeof params.threadId === "string" ? params.threadId : String(params.threadId ?? "");
					const supplied = typeof params.providerThreadId === "string" && params.providerThreadId ? params.providerThreadId : undefined;
					const rootStart = this.registry.observationForThread(threadId) && method === "thread/start";
					const providerThreadId = this.registry.resolveProviderIdentity(threadId, rootStart ? undefined : supplied);
					if (rootStart && supplied && supplied !== providerThreadId) throw new Error("BB_OWNER_ROOT_IDENTITY_MUST_BE_CANONICAL");
					// Existing identity lifecycle runs before any grant/startup failure. Deterministic fallback survives provider retirement.
					this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, { providerThreadId, sessionRestorable: true });
					break;
				}

				case "thread/fork": {
					const threadId = typeof params.threadId === "string" ? params.threadId : String(params.threadId ?? "");
					if (this.registry.observationForThread(threadId) || (typeof params.sourceProviderThreadId === "string" && params.sourceProviderThreadId.startsWith("pi_durable_bb_")))
						throw new Error("BB_OWNER_FORK_UNSUPPORTED: controlled pairing cannot fork native storage");
					const sourceProviderThreadId = params.sourceProviderThreadId;
					const checkpointId = params.sourceProviderCheckpointId;
					const targetProviderThreadId = `pi_durable_${Date.now()}`;

					try {
						if (sourceProviderThreadId) {
							forkSessionDatabase({
								sourceProviderThreadId: String(sourceProviderThreadId),
								targetProviderThreadId,
								checkpointId: checkpointId !== undefined ? String(checkpointId) : undefined,
							});
						}
						await this.registry.createOrGet(threadId, targetProviderThreadId, params);
						this.sendResult(id, { providerThreadId: targetProviderThreadId, sessionRestorable: true });
					} catch (err) {
						this.sendError(id, -32000, err instanceof Error ? err.message : String(err));
					}
					break;
				}

				case "turn/start": {
					this.registry.assertObservationControl(String(params.threadId ?? ""));
					await this.preflightControlled(String(params.threadId ?? ""), params.providerThreadId, true, params);
					await handleTurnStart(id, params as unknown as TurnStartParams, this.routerContext);
					break;
				}

				case "turn/steer": {
					this.registry.assertObservationControl(String(params.threadId ?? ""));
					await this.preflightControlled(String(params.threadId ?? ""), params.providerThreadId, true);
					await handleTurnSteer(id, params as unknown as TurnSteerParams, this.routerContext);
					break;
				}

				case "thread/stop": {
					if (params.intent === "interrupt") {
						this.registry.assertObservationControl(String(params.threadId ?? ""));
						await this.preflightControlled(String(params.threadId ?? ""), params.providerThreadId, false);
					}
					await handleThreadStop(id, params as unknown as ThreadStopParams, this.routerContext);
					break;
				}

				case "thread/discard": {
					await this.registry.stop(String(params.threadId ?? ""));
					this.sendResult(id, { ok: true });
					break;
				}

				case "skills/configure": {
					this.sendResult(id, { ok: true });
					break;
				}

				default:
					this.sendError(id, -32601, `Method not found: ${method}`);
					break;
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.sendError(id, -32000, message);
		}
	}

	public async shutdown(): Promise<void> {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Provider bridge closed before native-thread registration completed"));
		}
		this.pendingRequests.clear();
		await this.registry.stopAll();
		getSharedCatalog().close();
	}
}
