import { spawn, type ChildProcess } from "node:child_process";
import { resolveRunnerPath } from "./paths.ts";
import { RunnerRpcChannel } from "./runner-rpc-channel.ts";
import type { RunnerEvent } from "./types.ts";

export interface RunnerProcessOptions {
	cwd: string;
	args: string[];
	env?: Record<string, string>;
	onEvent?: (event: RunnerEvent) => void;
	onChannelMessage?: (msg: unknown) => void;
	onError?: (err: Error) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class RunnerProcess {
	private options: RunnerProcessOptions;
	private child: ChildProcess;
	private channel = new RunnerRpcChannel();
	public exited = false;
	private sharedHost = false;

	constructor(options: RunnerProcessOptions) {
		this.options = options;
		const runnerPath = process.env.PI_DURABLE_RUNNER_PATH || resolveRunnerPath();

		this.child = spawn(process.execPath, [runnerPath, ...options.args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
			env: { ...process.env, ...options.env },
		});

		this.setupStreams();
		this.setupLifecycle();
	}

	public get pendingRequests() {
		return this.channel.pendingRequests;
	}

	private setupStreams() {
		this.child.stdout?.on("data", (chunk: Buffer) => {
			this.channel.feedStdout(chunk, (event) => this.handleIncoming(event));
		});

		const channelIn = (this.child.stdio as unknown as Array<NodeJS.ReadableStream | null>)[3];
		if (channelIn) {
			channelIn.on("data", (chunk: Buffer) => {
				this.channel.feedChannel(chunk, (msg) => {
					if (msg && typeof msg === "object" && "sharedHost" in msg && msg.sharedHost === true) this.sharedHost = true;
					this.options.onChannelMessage?.(msg);
				});
			});
		}
	}

	private setupLifecycle() {
		this.child.on("error", (err) => {
			this.exited = true;
			this.channel.failAll(err);
			this.options.onError?.(err);
		});

		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.channel.failAll(new Error(`Runner process exited (code ${code}, signal ${signal})`));
			this.options.onExit?.(code, signal);
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (!text.includes("DeprecationWarning")) {
				console.error(`[RunnerProcess:stderr] ${text}`);
			}
		});
	}

	public handleIncoming(msg: RunnerEvent): void {
		const handled = this.channel.handleIncoming(msg);
		if (!handled) {
			try {
				this.options.onEvent?.(msg);
			} catch (err) {
				console.error("[RunnerProcess] onEvent subscriber threw an error:", err);
			}
		}
	}

	public async request(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
		if (this.exited || !this.child.stdin) {
			throw new Error("Runner process is not running");
		}
		return this.channel.createRequest(cmd, timeoutMs, (payload) => {
			this.child.stdin?.write(JSON.stringify(payload) + "\n");
		});
	}

	public async requestOk(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
		const res: any = await this.request(cmd, timeoutMs);
		if (res && typeof res === "object") {
			if (res.success === false) {
				throw new Error(res.error || `Runner rejected ${String(cmd.type)}`);
			}
			return res.data !== undefined ? res.data : (res.result ?? res);
		}
		return res;
	}

	public sendChannel(msg: unknown): void {
		const channelOut = (this.child.stdio as unknown as Array<NodeJS.WritableStream | null>)[4];
		if (channelOut) {
			channelOut.write(JSON.stringify(msg) + "\n");
		}
	}

	public async closeGracefully(timeoutMs = 5000): Promise<void> {
		if (this.exited) return;

		try {
			// Closing a BB client must not abort the native terminal conversation.
			if (!this.sharedHost) await this.request({ type: "abort" }, Math.max(1000, Math.floor(timeoutMs / 2)));
		} catch (err) {
			console.warn(`[RunnerProcess] Abort request before shutdown skipped: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.child.stdin?.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.kill();
				resolve();
			}, timeoutMs);

			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	public kill(): void {
		if (!this.exited) {
			this.exited = true;
			try {
				this.child.kill("SIGTERM");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code !== "ESRCH") {
					console.warn(`[RunnerProcess] SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const timer = setTimeout(() => {
				if (this.child.exitCode === null && this.child.signalCode === null) {
					try {
						this.child.kill("SIGKILL");
					} catch (err) {
						const code = (err as NodeJS.ErrnoException)?.code;
						if (code !== "ESRCH") {
							console.warn(`[RunnerProcess] SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				}
			}, 500);
			timer.unref();
		}
	}
}
