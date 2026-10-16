import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";

// The BB8 candidate intentionally contains only its owned files. Resolve unchanged
// relative host modules from the donor while loading the actual candidate server.
const candidateDir = dirname(fileURLToPath(import.meta.url));
const donorDir = "/home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/experimental/durable";
registerHooks({ resolve(specifier, context, nextResolve) {
	if (context.parentURL?.startsWith(pathToFileURL(candidateDir).href) && specifier.startsWith("./")) {
		const candidate = resolve(candidateDir, specifier);
		if (!existsSync(candidate)) return { url: pathToFileURL(resolve(donorDir, specifier)).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
} });
const { listenSharedHost, writeSocketFrame } = await import("./shared-server.ts");

test("shared host watcher awaits drain, retains event order, and Durable execution completes", { timeout: 45000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bb8-backpressure-"));
	const socketPath = join(directory, "shared.sock");
	const provider = fauxProvider();
	const marker = "committed-frame-start:";
	provider.setResponses(Array.from({ length: 2 }, () => () => fauxAssistantMessage(marker + "x".repeat(3 * 1024 * 1024))));
	const models = createModels(); models.setProvider(provider.provider);
	const registry = createRegistry();
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
	const host = {
		harness,
		view: { current: () => ({ session: { cwd: process.cwd() }, conversation: {} }), subscribe: () => () => {} },
	};
	const endpoint = await listenSharedHost(host as never, socketPath);
	const client = createConnection(socketPath);
	let buffered = "";
	const messages: any[] = [];
	client.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		let end: number;
		while ((end = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
			try { messages.push(JSON.parse(line)); } catch {}
		}
	});
	const waitFor = async (predicate: () => boolean) => {
		const until = Date.now() + 10000;
		while (!predicate()) { if (Date.now() > until) throw new Error(`timed out waiting for shared-host frame; destroyed=${client.destroyed}; buffered=${buffered.length}; messages=${messages.map((m) => `${m.type ?? "?"}:${m.id ?? ""}:${m.success ?? ""}`).join(",")}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
	};
	t.after(async () => { client.destroy(); await endpoint.close(); await harness.close(context); await rm(directory, { recursive: true, force: true }); });
	await once(client, "connect");
	client.write(`${JSON.stringify({ type: "attach", id: "attach", cwd: process.cwd() })}\n`);
	await waitFor(() => messages.some((message) => message.id === "attach" && message.success));
	client.pause();

	const submission = await root.submit({ type: "input", content: "emit large committed frame", requestId: "backpressure-test" }, context);
	let timeout: ReturnType<typeof setTimeout>;
	const result = await Promise.race([
		submission.wait(context),
		new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Durable execution stalled behind socket drain")), 12000); timeout.unref(); }),
	]).finally(() => clearTimeout(timeout));
	assert.equal(result.status, "done", "Durable execution completes while event presentation is backpressured");
	client.resume();
	await waitFor(() => messages.some((message) => message.type === "agent_events" && JSON.stringify(message.events).includes(marker)));
	const eventMessage = messages.find((message) => message.type === "agent_events" && JSON.stringify(message.events).includes(marker));
	assert.ok(eventMessage);
	assert.ok(messages.filter((message) => message.type === "agent_events").length >= 2, "committed watch frames arrive after resume");
});

test("candidate socket writer awaits drain and keeps committed-frame order", async (t) => {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const accepted = once(server, "connection");
	const client = createConnection(address.port, "127.0.0.1");
	await once(client, "connect");
	const [producer] = await accepted as [Socket];
	let received = "";
	client.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
	client.pause();
	t.after(() => {
		client.destroy();
		producer.destroy();
		server.close();
	});

	const delivered: number[] = [];
	let deliverySettled = false;
	const largeCommittedFrame = `${JSON.stringify({ sequence: 1, committed: "x".repeat(15 * 1024 * 1024) })}\n`;
	const delivery = (async () => {
		await writeSocketFrame(producer, largeCommittedFrame);
		delivered.push(1);
		await writeSocketFrame(producer, `${JSON.stringify({ sequence: 2, committed: "next" })}\n`);
		delivered.push(2);
	})();
	void delivery.then(() => { deliverySettled = true; });

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(deliverySettled, false, "watch delivery stays pending while the consumer socket is paused");
	assert.deepEqual(delivered, [], "later watch frames are not delivered ahead of the blocked write");
	const bothFramesReceived = new Promise<void>((resolve) => {
		const check = () => { if (received.includes('"sequence":2')) resolve(); };
		client.on("data", check);
		check();
	});
	client.resume();
	await delivery;
	await bothFramesReceived;
	assert.deepEqual(delivered, [1, 2]);
	assert.match(received, /"sequence":1/);
	assert.ok(received.indexOf('"sequence":1') < received.indexOf('"sequence":2'));
});

test("blocked candidate write settles on peer detach and removes listeners", async (t) => {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const accepted = once(server, "connection");
	const client = createConnection(address.port, "127.0.0.1");
	await once(client, "connect");
	const [producer] = await accepted as [Socket];
	client.pause();
	t.after(() => { client.destroy(); producer.destroy(); server.close(); });

	const blocked = writeSocketFrame(producer, `${"x".repeat(15 * 1024 * 1024)}\n`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(producer.listenerCount("drain") > 0);
	client.destroy(); // Detach/cancel the remote delivery by closing its peer.
	await blocked;
	assert.equal(producer.listenerCount("drain"), 0);
	assert.equal(producer.listenerCount("close"), 0);
	assert.equal(producer.listenerCount("error"), 0);
});

test("blocked candidate write settles on socket error without listener leaks", async (t) => {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const accepted = once(server, "connection");
	const client = createConnection(address.port, "127.0.0.1");
	await once(client, "connect");
	const [producer] = await accepted as [Socket];
	client.pause();
	t.after(() => { client.destroy(); producer.destroy(); server.close(); });

	const blocked = writeSocketFrame(producer, `${"x".repeat(15 * 1024 * 1024)}\\n`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(producer.listenerCount("drain") > 0);
	producer.emit("error", new Error("test socket failure"));
	await blocked;
	assert.equal(producer.listenerCount("drain"), 0);
	assert.equal(producer.listenerCount("close"), 0);
	assert.equal(producer.listenerCount("error"), 0);
});
