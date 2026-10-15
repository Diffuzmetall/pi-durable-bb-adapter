import { createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { once } from "node:events";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, watchEvents, type AgentEventStream, type ConversationId } from "@earendil-works/pi-durable";
import type { OpenDurableResult } from "./runtime.ts";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { ConversationView } from "@earendil-works/pi-durable";
import { sharedCommand, type SharedCommand } from "./shared-commands.ts";
import { createSharedReplay } from "./shared-replay.ts";

/** An opt-in endpoint owned by the existing runtime, never another SQLite owner. */
export async function listenSharedHost(host: OpenDurableResult, path: string) {
	if (!isAbsolute(path)) throw new Error("Shared socket path must be absolute");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const parent = await lstat(dirname(path));
	if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077))
		throw new Error("Shared socket requires a private, user-owned directory (0700)");
	const clients = new Set<Socket>();
	const disposals = new Set<Promise<void>>();
	const server = createServer((socket) => {
		clients.add(socket);
		socket.setEncoding("utf8");
		let buffer = "", attached = false, stopped = false, queue = Promise.resolve();
		const streams = new Map<number, AgentEventStream>();
		const pending = new Set<number>();
		const views = new Map<number, AttachedReplicatedState<ConversationView>>();
		const unsubs: Array<() => void> = [];
		let graph: Awaited<ReturnType<typeof host.harness.taskGraph>> | undefined;
		const send = (value: unknown) => {
			if (stopped || socket.destroyed) return;
			const line = JSON.stringify(value) + "\n";
			if (line.length + socket.writableLength > 16 * 1024 * 1024) { socket.destroy(); return; }
			socket.write(line);
		};
		const view = (id: number) => ({ ...host.view.current(),
			conversation: views.get(id)?.value ?? host.view.current().conversation, tasks: graph?.value });
		const watch = async (id: ConversationId, parentCallId?: string) => {
			if (stopped || pending.has(id)) return;
			pending.add(id);
			const conversation = await host.harness.conversation(id, context);
			if (!conversation || stopped) return;
			const state = await conversation.viewState(context);
			if (stopped) { state.dispose(); return; }
			views.set(id, state);
			const stream = await watchEvents(host.harness, id, context);
			if (stopped) { state.dispose(); await stream.stop(); return; }
			streams.set(id, stream);
			const replay = createSharedReplay(!!parentCallId);
			const receive = async (batch: readonly import("@earendil-works/pi-durable").AgentEvent[]) => {
				const events = replay(batch);
				send({ type: "agent_events", conversationId: id, parentCallId, events, view: view(id) });
				for (const event of events) {
					const child = event.type === "tool_execution_update" ? event.details?.conversationId :
						event.type === "tool_execution_end" ? (event.entry?.data as { conversationId?: number })?.conversationId : undefined;
					if (typeof child === "number" && "toolCallId" in event)
						void watch(child as ConversationId, parentCallId ? `${parentCallId}:${event.toolCallId}` : event.toolCallId).catch(() => socket.destroy());
				}
			};
			await receive([stream.snapshot]);
			stream.start(receive);
		};
		socket.on("error", () => socket.destroy());
		socket.once("end", () => socket.destroy());
		socket.once("close", () => {
			stopped = true; clients.delete(socket);
			for (const fn of unsubs) fn();
			for (const state of views.values()) state.dispose();
			graph?.dispose();
			const done = Promise.allSettled([...streams.values()].map((s) => s.stop())).then(() => {});
			disposals.add(done); void done.finally(() => disposals.delete(done));
		});
		const handle = async (cmd: SharedCommand) => {
			try {
				if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string" || typeof cmd.id !== "string")
					throw new Error("Expected command type and id");
				if (cmd.type === "attach") {
					if (attached) throw new Error("Already attached");
					if (typeof cmd.cwd !== "string" || await realpath(cmd.cwd) !== await realpath(host.view.current().session.cwd))
						throw new Error("Shared host belongs to a different working directory");
					if (stopped) return;
					attached = true;
					graph = await host.harness.taskGraph(context);
					if (stopped) { graph.dispose(); return; }
					await watch(ROOT_CONVERSATION_ID);
					unsubs.push(host.view.subscribe(() => send({ type: "shared_view", view: view(ROOT_CONVERSATION_ID) })));
					unsubs.push(graph.subscribe(() => send({ type: "shared_view", view: view(ROOT_CONVERSATION_ID) })));
					send({ type: "response", id: cmd.id, command: cmd.type, success: true, data: view(ROOT_CONVERSATION_ID) });
					return;
				}
				if (!attached) throw new Error("Attach first");
				if (cmd.conversationId !== undefined && Number(cmd.conversationId) !== ROOT_CONVERSATION_ID && !streams.has(Number(cmd.conversationId)))
					throw new Error("Child conversation is not attached; connect while its parent call is active");
				const data = await sharedCommand(host, cmd);
				send({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
			} catch (error) {
				send({ type: "response", id: cmd?.id, command: cmd?.type, success: false,
					error: error instanceof Error ? error.message : String(error) });
			}
		};
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
			let end: number;
			while ((end = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				queue = queue.then(async () => {
					if (stopped) return;
					try { await handle(JSON.parse(line)); } catch { socket.destroy(); }
				});
			}
		});
	});
	// Do not unlink a pre-existing socket: it may belong to a live runtime.
	server.listen(path);
	await once(server, "listening");
	try { await chmod(path, 0o600); }
	catch (error) { await new Promise<void>((resolve) => server.close(() => resolve())); throw error; }
	return { async close() {
		for (const socket of clients) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await Promise.allSettled(disposals);
	} };
}
