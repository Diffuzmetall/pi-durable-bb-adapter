import { createServer, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PROTOCOL = "bb-native-child-registration/v1" as const;
const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NativeChildRegistrationRequest {
	requestId: string;
	conversationId: number;
	title?: string;
}

export interface NativeChildRegistrationReceipt extends NativeChildRegistrationRequest {
	providerId: string;
	sessionId: string;
	parentThreadId: string;
	threadId: string;
}

interface RequestFrame extends NativeChildRegistrationRequest {
	protocol: typeof PROTOCOL;
	type: "register-existing";
	id: string;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRequest(value: unknown): RequestFrame | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	if (!exactKeys(frame, ["conversationId", "id", "protocol", "requestId", ...(frame.title === undefined ? [] : ["title"]), "type"]) ||
		frame.protocol !== PROTOCOL || frame.type !== "register-existing" ||
		typeof frame.id !== "string" || !UUID.test(frame.id) ||
		!nonEmpty(frame.requestId) || frame.requestId.length > 200 ||
		!Number.isSafeInteger(frame.conversationId) || (frame.conversationId as number) <= 0 ||
		(frame.title !== undefined && (!nonEmpty(frame.title) || frame.title.length > 500))) {
		return undefined;
	}
	return frame as unknown as RequestFrame;
}

function validReceipt(value: NativeChildRegistrationReceipt, request: RequestFrame): boolean {
	return value !== null && typeof value === "object" &&
		value.requestId === request.requestId && value.conversationId === request.conversationId &&
		[ value.providerId, value.sessionId, value.parentThreadId, value.threadId ].every(nonEmpty);
}

/** Session-owned one-request-per-connection provider IPC. Caller identity never comes from the wire. */
export class NativeChildRegistrationServer {
	public readonly socketPath: string;
	public readonly ready: Promise<void>;
	private readonly directory: string;
	private readonly server = createServer((socket) => { void this.handle(socket); });
	private closed = false;

	constructor(
		scratchDir: string,
		private readonly register: (request: NativeChildRegistrationRequest) => Promise<NativeChildRegistrationReceipt>,
	) {
		this.directory = mkdtempSync(join(scratchDir, "ncr-"));
		chmodSync(this.directory, 0o700);
		this.socketPath = join(this.directory, "r.sock");
		const pathBytes = Buffer.byteLength(this.socketPath, "utf8");
		if (pathBytes > 107) {
			this.cleanupPath();
			throw new Error(`Native child registration socket path is ${pathBytes} UTF-8 bytes (Linux limit 107); use a shorter TMPDIR`);
		}
		const uid = process.getuid?.();
		const directory = lstatSync(this.directory);
		if (uid === undefined || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
			this.cleanupPath();
			throw new Error("Native child registration socket directory must be private and user-owned");
		}
		this.ready = new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => { this.cleanupPath(); reject(error); };
			this.server.once("error", onError);
			this.server.listen(this.socketPath, () => {
				this.server.removeListener("error", onError);
				try {
					chmodSync(this.socketPath, 0o600);
					const socket = lstatSync(this.socketPath);
					if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
						throw new Error("Native child registration socket must be private and user-owned");
					}
					resolve();
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					this.server.close(() => this.cleanupPath());
				}
			});
		});
	}

	private async handle(socket: Socket): Promise<void> {
		socket.setEncoding("utf8");
		socket.setTimeout(REQUEST_TIMEOUT_MS);
		let buffer = "";
		let finished = false;
		let processing = false;
		const fail = (id: string, error = "Native child registration refused") => {
			if (finished) return;
			finished = true;
			if (!socket.destroyed) {
				socket.end(JSON.stringify({ protocol: PROTOCOL, type: "result", id, success: false, error }) + "\n");
			}
		};
		socket.on("error", () => { finished = true; });
		socket.once("timeout", () => fail("", "Native child registration timed out"));
		socket.on("data", (chunk: string) => {
			if (finished || processing) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
				fail("");
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			if (buffer.slice(newline + 1).trim()) {
				fail("");
				return;
			}
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { fail(""); return; }
			const request = parseRequest(parsed);
			if (!request) { fail(""); return; }
			processing = true;
			void Promise.resolve().then(() => this.register({ requestId: request.requestId, conversationId: request.conversationId,
				...(request.title === undefined ? {} : { title: request.title }) })).then((receipt) => {
				if (!validReceipt(receipt, request)) {
					fail(request.id);
					return;
				}
				finished = true;
				if (!socket.destroyed) {
					socket.end(JSON.stringify({ protocol: PROTOCOL, type: "result", id: request.id, success: true, receipt }) + "\n");
				}
			}, () => fail(request.id));
		});
		socket.once("end", () => {
			if (!finished && buffer.trim()) fail("");
		});
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try { await this.ready; } catch { this.cleanupPath(); return; }
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.cleanupPath();
	}

	private cleanupPath(): void {
		try { unlinkSync(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		try { rmdirSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
