import { StringDecoder } from "node:string_decoder";
import type { RunnerEvent } from "./types.ts";

export interface PendingRequest {
	resolve: (val: unknown) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

export class RunnerRpcChannel {
	public pendingRequests = new Map<string, PendingRequest>();
	private nextRequestId = 0;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuf = "";
	private channelDecoder = new StringDecoder("utf8");
	private channelBuf = "";

	public feedStdout(chunk: Buffer, onEvent: (event: RunnerEvent) => void): void {
		this.stdoutBuf += this.stdoutDecoder.write(chunk);
		const lines = this.stdoutBuf.split("\n");
		this.stdoutBuf = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as RunnerEvent;
				const handled = this.handleIncoming(parsed);
				if (!handled) {
					onEvent(parsed);
				}
			} catch (err) {
				console.error(`[RunnerRpcChannel] Failed to parse stdout line: ${trimmed}`, err);
			}
		}
	}

	public feedChannel(chunk: Buffer, onMessage: (msg: unknown) => void): void {
		this.channelBuf += this.channelDecoder.write(chunk);
		const lines = this.channelBuf.split("\n");
		this.channelBuf = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				onMessage(parsed);
			} catch (err) {
				console.error(`[RunnerRpcChannel] Failed to parse channel line: ${trimmed}`, err);
			}
		}
	}

	public createRequest(
		cmd: Record<string, unknown>,
		timeoutMs: number,
		sendJson: (payload: Record<string, unknown>) => void,
	): Promise<unknown> {
		this.nextRequestId++;
		const id = `req_${this.nextRequestId}`;
		const payload = { ...cmd, id };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Runner request timed out (${timeoutMs}ms): ${cmd.type || JSON.stringify(cmd)}`));
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timer });
			sendJson(payload);
		});
	}

	public handleIncoming(msg: RunnerEvent): boolean {
		if (typeof msg.id === "undefined") return false;
		const reqId = String(msg.id);
		const pending = this.pendingRequests.get(reqId);
		if (!pending) return false;

		if (pending.timer) clearTimeout(pending.timer);
		this.pendingRequests.delete(reqId);

		if (msg.error) {
			const errObj = msg.error as { message?: string };
			pending.reject(new Error(errObj?.message || String(msg.error)));
		} else {
			pending.resolve(msg.data !== undefined ? msg.data : (msg.result ?? msg));
		}
		return true;
	}

	public failAll(err: Error): void {
		for (const { reject, timer } of this.pendingRequests.values()) {
			if (timer) clearTimeout(timer);
			reject(err);
		}
		this.pendingRequests.clear();
	}
}
