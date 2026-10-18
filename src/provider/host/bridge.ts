import { getSharedCatalog } from "./catalog.ts";
import { SessionRegistry } from "./session-registry.ts";
import { handleDiscoveryRequest } from "./discovery-handler.ts";
import { forkSessionDatabase } from "./thread-fork.ts";
import {
	sendJsonRpcResult,
	sendJsonRpcError,
	sendJsonRpcNotification,
} from "./jsonrpc.ts";
import {
	handleTurnStart,
	handleTurnSteer,
	handleThreadStop,
	type BridgeRouterContext,
	type TurnStartParams,
	type TurnSteerParams,
	type ThreadStopParams,
} from "./bridge-router.ts";

export class ProviderBridge {
	private sendRaw: (json: string) => void;
	private registry: SessionRegistry;

	constructor(sendRaw: (json: string) => void, registry?: SessionRegistry) {
		this.sendRaw = sendRaw;
		this.registry = registry ?? new SessionRegistry((method, params) => {
			this.sendNotification(method, params);
		});
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

		let req: { id?: string | number; method?: string; params?: Record<string, unknown> };
		try {
			req = JSON.parse(trimmed);
		} catch (err) {
			console.error(`[ProviderBridge] Invalid JSON received from daemon: ${trimmed}`, err);
			this.sendError(0, -32700, "Parse error: Invalid JSON");
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
					const providerThreadId = typeof params.providerThreadId === "string" && params.providerThreadId
						? params.providerThreadId
						: `pi_durable_${Date.now()}`;
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, { providerThreadId, sessionRestorable: true });
					break;
				}

				case "thread/fork": {
					const threadId = typeof params.threadId === "string" ? params.threadId : String(params.threadId ?? "");
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
					await handleTurnStart(id, params as unknown as TurnStartParams, this.routerContext);
					break;
				}

				case "turn/steer": {
					await handleTurnSteer(id, params as unknown as TurnSteerParams, this.routerContext);
					break;
				}

				case "thread/stop": {
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
		await this.registry.stopAll();
		getSharedCatalog().close();
	}
}
