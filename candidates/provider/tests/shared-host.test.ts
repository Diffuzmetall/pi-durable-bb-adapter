import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, stat, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { sharedHostSocket, runSharedHost } from "../src/runner/shared-host.ts";
import { RunnerProcess } from "../src/host/runner-process.ts";

const serverPath = process.env.PI_DURABLE_SHARED_HOST_MODULE;
// Default: npm test (binding test only; integration reports an explicit skip).
// Integration: PI_DURABLE_SHARED_HOST_MODULE=/path/to/shared-server.ts \
// PI_DURABLE_GLOBAL_ROOT=/path/to/global/node_modules \
// PI_DURABLE_SHARED_HOST_LOADER=/path/to/global-runtime.mjs \
// PI_DURABLE_RUNNER_PATH="$PWD/dist/runner/index.js" node --test tests/shared-host.test.ts
// Never apply the global loader to npm test: only the child needs its package graph.

test("shared binding is opt-in and rejects public or malformed pointers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "durable-binding-"));
	assert.equal(await sharedHostSocket(dir), undefined);
	const path = join(dir, "shared-host.json");
	await writeFile(path, JSON.stringify({ socket: "/private/runtime.sock" }), { mode: 0o600 });
	assert.equal(await sharedHostSocket(dir), "/private/runtime.sock");
	await chmod(path, 0o644);
	await assert.rejects(sharedHostSocket(dir), /private/);
	await chmod(path, 0o600);
	await writeFile(path, JSON.stringify({ socket: "relative.sock" }));
	await assert.rejects(sharedHostSocket(dir), /absolute/);
});

test("real SQLite host: two BB clients share work, disconnect safely and fail closed", {
	skip: !serverPath && "Set PI_DURABLE_SHARED_HOST_MODULE to run the real native-host integration (see command above)",
	timeout: 45000,
}, async (t) => {
	if (process.env.PI_DURABLE_SHARED_HOST_TEST_CHILD !== "1") {
		const env: NodeJS.ProcessEnv = { ...process.env, PI_DURABLE_SHARED_HOST_TEST_CHILD: "1" };
		delete env.NODE_TEST_CONTEXT;
		const loader = env.PI_DURABLE_SHARED_HOST_LOADER ?? join(homedir(), ".local/share/pi-durable/global-runtime.mjs");
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [
			"--import", loader, "--test", "--test-name-pattern", "^real SQLite host:", fileURLToPath(import.meta.url),
		], { env, timeout: 40000 });
		t.diagnostic(stdout); if (stderr) t.diagnostic(stderr);
		return;
	}
	const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
	const { Type } = await import("@earendil-works/pi-ai");
	const { createModels } = await import("@earendil-works/pi-ai/models");
	const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const { createRegistry, defineExtension, defineTool, Harness } = await import("@earendil-works/pi-durable");
	const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
	const { listenSharedHost } = await import(pathToFileURL(serverPath!).href);
	const dir = await mkdtemp(join(tmpdir(), "durable-shared-"));
	await chmod(dir, 0o700);
	const registry = createRegistry();
	let started!: () => void, release!: () => void;
	const entered = new Promise<void>((r) => { started = r; });
	const held = new Promise<void>((r) => { release = r; });
	let executions = 0, childExecutions = 0, childId: number | undefined;
	registry.install(defineExtension({ name: "shared-smoke", tools: [defineTool({
		name: "hold", description: "Delegate one held child", parameters: Type.Object({}),
		execute: async (_args, api, toolContext) => {
			executions++;
			const id = await api.commit(async (tx) =>
				(await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id, toolContext);
			childId = id;
			await api.details({ conversationId: id }, toolContext);
			const child = await api.conversation(id, toolContext);
			await (await child!.submit({ type: "input", content: "Hold, then answer once" }, toolContext)).wait(toolContext);
			return {};
		},
	}), defineTool({
		name: "child_hold", description: "Hold child execution until the late client attaches", parameters: Type.Object({}),
		execute: async () => { childExecutions++; started(); await held; return {}; },
	})] }));
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("hold", {}, { id: "held" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("child_hold", {}, { id: "child-held" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("SHARED_CHILD_DONE")]),
		fauxAssistantMessage([fauxText("SHARED_HOST_DONE")]),
	]);
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const view = await root.viewState(context);
	const state = () => ({ session: { id: "test", directory: dir, cwd: dir }, conversation: view.value,
		conversations: [{ id: root.id, label: "main" }], models: [], notices: [] });
	const host = { harness, modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
		view: { current: state, subscribe: (fn: () => void) => view.subscribe(fn) },
		submitTo: async (id: number, text: string, whenBusy: "steer" | "followUp") => {
			const conv = await harness.conversation(id as never, context);
			await conv!.submit({ type: "input", content: text, whenBusy }, context);
		} };
	const server = await listenSharedHost(host, join(dir, "runtime.sock"));
	let runner: RunnerProcess | undefined;
	const clients: Array<{ input: PassThrough; frames: any[]; done: Promise<void>; ready: Promise<void> }> = [];
	const wait = async (predicate: () => boolean) => {
		const deadline = Date.now() + 5000;
		while (!predicate()) { if (Date.now() > deadline) throw new Error("Missing shared-host event"); await new Promise((r) => setImmediate(r)); }
	};
	const connect = (cwd = dir) => {
		const input = new PassThrough(), frames: any[] = [];
		let ready!: () => void;
		const readyPromise = new Promise<void>((r) => { ready = r; });
		const done = runSharedHost(join(dir, "runtime.sock"), cwd, input, (f) => frames.push(f), (f: any) => {
			if (f.ready) { assert.equal(f.sharedHost, true); assert.equal(f.session.id, "test"); ready(); }
		});
		void done.catch(() => {});
		const client = { input, frames, done, ready: readyPromise }; clients.push(client); return client;
	};
	try {
		assert.equal((await stat(join(dir, "runtime.sock"))).mode & 0o777, 0o600);
		const a = connect(), b = connect(); await Promise.all([a.ready, b.ready]);
		const wrong = connect(tmpdir()); await assert.rejects(wrong.done, /different working directory/); wrong.input.end();
		const clientDirectory = join(dir, "client");
		await mkdir(clientDirectory);
		await writeFile(join(clientDirectory, "shared-host.json"), JSON.stringify({ socket: join(dir, "runtime.sock") }), { mode: 0o600 });
		let readyRunner!: () => void, rejectRunner!: (error: Error) => void;
		const runnerReady = new Promise<void>((resolve, reject) => { readyRunner = resolve; rejectRunner = reject; });
		runner = new RunnerProcess({ cwd: dir, args: ["--session", clientDirectory], onChannelMessage: (msg: any) => {
			if (msg.ready) {
				if (msg.sharedHost) readyRunner();
				else rejectRunner(new Error("Built runner did not attach to shared host; rebuild dist/runner/index.js before integration"));
			}
		}, onError: rejectRunner, onExit: (code) => rejectRunner(new Error(`Runner exited before shared-host readiness (${code})`)) });
		const timer = setTimeout(() => rejectRunner(new Error("Built runner shared-host readiness timed out")), 10000);
		try { await runnerReady; } finally { clearTimeout(timer); }
		await runner.requestOk({ type: "prompt", message: "Start once" });
		await entered;
		await wait(() => a.frames.some((f) => f.type === "tool_execution_start") && b.frames.some((f) =>
			f.type === "tool_execution_update" && f.toolCallId === "held" && f.details?.conversationId === childId));
		await runner.closeGracefully();
		a.input.end(); await a.done;
		// The child and published parent details predate this connection: only snapshot replay can discover it.
		const c = connect(); await c.ready;
		await wait(() => c.frames.some((f) => f.type === "tool_execution_start" &&
			f.toolCallId === "held:child-held" && f.parentRef === "held" && f.conversationId === childId));
		assert.ok(Object.keys((await harness.taskGraph(context)).value.tasks).length > 0);
		assert.ok(c.frames.some((f) => f.type === "tasks_snapshot" && f.steps.length > 0),
			"shared attachment preserves the deployed task-graph bridge");
		release();
		const childFrames = () => c.frames.filter((f) => f.parentRef === "held" && f.conversationId === childId);
		try {
			await wait(() => childFrames().filter((f) => f.type === "message_update")
				.map((f) => f.assistantMessageEvent?.delta ?? "").join("").includes("SHARED_CHILD_DONE"));
		} catch (error) { t.diagnostic(JSON.stringify({ late: c.frames, early: b.frames })); throw error; }
		await wait(() => childFrames().findLastIndex((f) => f.type === "agent_end") >
			childFrames().findLastIndex((f) => f.type === "message_update"));
		const childText = childFrames().filter((f) => f.type === "message_update")
			.map((f) => f.assistantMessageEvent?.delta ?? "").join("");
		assert.equal(childText, "SHARED_CHILD_DONE", "late client receives output under the original parent call");
		await wait(() => b.frames.some((f) => f.type === "agent_end" && !f.parentRef));
		assert.ok(JSON.stringify(b.frames).includes("SHARED_HOST_DONE"));
		assert.equal(executions, 1, "late attach must not resubmit the parent");
		assert.equal(childExecutions, 1, "late attach must not resubmit the child");
		c.input.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
		await wait(() => c.frames.some((f) => f.id === "state" && f.success));
		b.input.end(); c.input.end(); await Promise.all([b.done, c.done]);
		await assert.rejects(access(join(dir, "client", "session.sqlite")));
	} finally {
		release(); if (runner && !runner.exited) await runner.closeGracefully();
		for (const c of clients) c.input.end();
		await Promise.allSettled(clients.map((c) => c.done));
		await server.close(); view.dispose(); await harness.close(context);
	}
	const dead = new PassThrough();
	await assert.rejects(runSharedHost(join(dir, "runtime.sock"), dir, dead, () => {}, () => {}), /ENOENT/);
});
