import { createConnection } from "node:net";
import { readFile, lstat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { join, isAbsolute } from "node:path";
import { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import { startTaskGraphBridge } from "./task-graph-bridge.ts";
import type { BBChildEventAdapter } from "./bridge/bb-child-event-adapter.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
import type { DurableView } from "./runtime-types.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

/** Explicit per-session binding; absence keeps the existing standalone path. */
export async function sharedHostSocket(session?: string): Promise<string | undefined> {
	if (!session) return undefined;
	const file = join(session, "shared-host.json");
	let info;
	try { info = await lstat(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077))
		throw new Error("Shared-host binding must be a private, user-owned file (0600)");
	const config = JSON.parse(await readFile(file, "utf8"));
	if (!config || typeof config.socket !== "string" || !isAbsolute(config.socket))
		throw new Error("Shared-host binding requires an absolute socket path");
	return config.socket;
}

/** Only a socket client: does not import runtime implementations or open SQLite. */
export async function runSharedHost(
	path: string, cwd: string, input: Readable,
	output: (frame: unknown) => void, channel: (frame: unknown) => void,
): Promise<void> {
	const info = await lstat(path);
	if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077))
		throw new Error("Shared socket must be private and user-owned (0600)");
	const socket = createConnection(path);
	let attached = false, detached = false;
	const children = new Map<number, BBChildEventAdapter>();
	const unsubscribers: Array<() => void> = [];
	let current: DurableView | undefined;
	const viewListeners = new Set<() => void>();
	const updateView = (view: DurableView) => { current = view; for (const listener of viewListeners) listener(); };
	const adapter = new BBEventAdapter(output, (provider, modelId) =>
		current?.models.find((m) => m.provider === provider && m.modelId === modelId)?.contextWindow);
	const detach = () => { detached = true; socket.destroy(); };
	process.once("SIGTERM", detach);
	process.once("SIGINT", detach);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("Shared-host attach timed out")); }, 15000);
			const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
			socket.on("error", fail);
			socket.once("close", () => { clearTimeout(timer); if (!detached) reject(new Error("Shared host disconnected")); else resolve(); });
			socket.once("connect", () => {
				socket.write(JSON.stringify({ id: "shared-attach", type: "attach", cwd }) + "\n");
			});
			unsubscribers.push(attachJsonlLineReader(socket, (line) => {
				try {
					const frame = JSON.parse(line);
					if (frame.type === "response" && frame.id === "shared-attach") {
						if (!frame.success) { fail(new Error(frame.error)); return; }
						current = frame.data;
						startTaskGraphBridge({ current: () => current!, subscribe: (listener) => {
							viewListeners.add(listener); return () => { viewListeners.delete(listener); };
						} }, output);
						attached = true; clearTimeout(timer);
						channel({ kind: "ready", ready: true, sharedHost: true, session: current?.session });
					} else if (frame.type === "shared_view") updateView(frame.view);
					else if (frame.type === "agent_events") {
						updateView(frame.view);
						let target: BBEventAdapter | BBChildEventAdapter = adapter;
						if (frame.parentCallId) {
							let child = children.get(frame.conversationId);
							if (!child) { child = adapter.createChildAdapter(frame.parentCallId, frame.conversationId); children.set(frame.conversationId, child); }
							target = child;
						}
						for (const event of frame.events as AgentEvent[]) target.handleEvent(event, frame.view);
					} else if (frame.type === "response") output(frame);
				} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
			}));
			unsubscribers.push(attachJsonlLineReader(input, (line) => {
				try {
					const cmd = JSON.parse(line);
					if (!attached || socket.destroyed) throw new Error("Shared host is not connected");
					socket.write(JSON.stringify(cmd) + "\n");
				} catch (error) {
					output({ type: "response", success: false, error: error instanceof Error ? error.message : String(error) });
				}
			}));
			input.once("end", detach);
		});
	} finally {
		for (const unsubscribe of unsubscribers) unsubscribe();
		viewListeners.clear();
		input.removeListener("end", detach);
		process.removeListener("SIGTERM", detach);
		process.removeListener("SIGINT", detach);
		socket.destroy();
	}
}
