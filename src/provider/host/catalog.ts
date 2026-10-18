import { requireExtensionPath } from "./paths.ts";
import { RunnerProcess } from "./runner-process.ts";
import type { AvailableModelDescriptor, ModelScope } from "./types.ts";
import { inspectPiEnvironment, type PiDiagnosticsReport } from "../runner/diagnostics.ts";

export class ModelCatalog {
	private cwd: string;
	private runner: RunnerProcess | null = null;
	private modelScope: ModelScope = {};
	private readyPromise: Promise<void>;
	private readyResolve!: () => void;
	private readyReject!: (err: Error) => void;
	private startupSettled = false;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
		this.readyPromise = this.createReadyPromise();
	}

	private createReadyPromise(): Promise<void> {
		this.startupSettled = false;
		const promise = new Promise<void>((resolve, reject) => {
			this.readyResolve = () => {
				if (!this.startupSettled) {
					this.startupSettled = true;
					resolve();
				}
			};
			this.readyReject = (err: Error) => {
				if (!this.startupSettled) {
					this.startupSettled = true;
					reject(err);
				}
			};
		});
		// Retain error trace if startup rejects before caller awaits start()
		promise.catch((err: unknown) => {
			if (process.env.DEBUG_STARTUP) {
				console.debug(`[Catalog] Early startup rejection: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		return promise;
	}

	public async start(): Promise<void> {
		if (this.runner && !this.runner.exited) return;

		if (this.runner?.exited) {
			this.runner = null;
		}

		this.readyPromise = this.createReadyPromise();

		const extensionPath = requireExtensionPath();
		this.runner = new RunnerProcess({
			cwd: this.cwd,
			args: ["--mode", "rpc", "--no-session", "--extension", extensionPath],
			onChannelMessage: (msg: any) => {
				if (msg?.kind === "model-scope") {
					this.modelScope = {
						scopedModelIds: msg.scopedModelIds,
						defaultModelId: msg.defaultModelId,
					};
				} else if (msg?.kind === "ready") {
					this.readyResolve();
				}
			},
			onError: (err) => {
				this.readyReject(new Error(`Catalog runner launch failed: ${err.message}`));
			},
			onExit: (code, signal) => {
				this.readyReject(new Error(`Catalog runner exited before becoming ready (code ${code}, signal ${signal})`));
			},
		});

		let timer: NodeJS.Timeout | null = null;
		try {
			await Promise.race([
				this.readyPromise,
				new Promise<void>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Catalog runner startup timed out")), 20000);
				}),
			]);
		} catch (err) {
			this.kill();
			throw err;
		} finally {
			if (timer !== null) {
				clearTimeout(timer);
			}
		}
	}

	public async listModels(): Promise<AvailableModelDescriptor[]> {
		await this.start();
		if (!this.runner) throw new Error("Catalog runner unavailable");

		const raw: any = await this.runner.requestOk({ type: "get_available_models" });
		const models: any[] = raw?.models ?? raw?.data?.models ?? [];
		const result: AvailableModelDescriptor[] = [];

		for (const m of models) {
			if (!m.id || !m.provider) continue;
			const fullId = `${m.provider}/${m.id}`;
			const isScoped = !this.modelScope.scopedModelIds || this.modelScope.scopedModelIds.includes(fullId);
			if (!isScoped) continue;

			const isDefault = fullId === this.modelScope.defaultModelId;
			const reasoningEfforts = (m.reasoningEfforts ?? ["low", "medium", "high"]).map((r: string) => ({
				reasoningEffort: r,
				description: `${r.charAt(0).toUpperCase() + r.slice(1)} reasoning effort`,
			}));

			result.push({
				id: fullId,
				model: fullId,
				displayName: `${m.name ?? m.id} (${m.provider})`,
				routeProviderId: m.provider,
				description: `${m.provider} model via Pi Durable`,
				supportedReasoningEfforts: reasoningEfforts,
				defaultReasoningEffort: m.defaultReasoningEffort ?? "medium",
				isDefault,
			});
		}

		if (result.length > 0 && !result.some((m) => m.isDefault)) {
			result[0].isDefault = true;
		}

		return result;
	}

	public async getDiagnostics(): Promise<PiDiagnosticsReport> {
		return inspectPiEnvironment({ cwd: this.cwd });
	}

	public async getHealth(): Promise<{ status: "ready" | "unauthenticated" | "unknown"; statusMessage?: string }> {
		try {
			const report = await this.getDiagnostics();
			if (report.status === "error") {
				return { status: "unknown", statusMessage: report.summary };
			}
			if (report.models.total === 0) {
				return { status: "unauthenticated", statusMessage: "No authenticated models available in Pi." };
			}
			return { status: "ready", statusMessage: report.summary };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { status: "unknown", statusMessage: msg };
		}
	}

	public kill(): void {
		if (this.runner) {
			this.runner.kill();
			this.runner = null;
		}
	}

	public close(): void {
		this.kill();
	}
}

let sharedCatalog: ModelCatalog | null = null;
export function getSharedCatalog(cwd?: string): ModelCatalog {
	if (!sharedCatalog) {
		sharedCatalog = new ModelCatalog(cwd);
	}
	return sharedCatalog;
}
