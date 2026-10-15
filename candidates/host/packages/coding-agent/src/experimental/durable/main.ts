#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { listenSharedHost } from "./shared-server.ts";

function parseArgs(argv: readonly string[]): OpenDurableOptions {
	let continueSession = false;
	let disableMcp = false;
	let session: string | undefined;
	// Hindsight durable adapter: the reload loader requires a default-export registry adapter
	// `(registry) => registry`, which hindsight/extension.mjs does not provide. adapter.mjs bridges
	// the two and installs the Hindsight extension on the host registry. More adapters: --extension <path>.
	const extensions: string[] = [fileURLToPath(new URL("./hindsight/adapter.mjs", import.meta.url))];
	let server: string | undefined;
	let tools: string[] | undefined;
	let agentName: string | undefined;
	let mcpOptionSeen = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else if (arg === "--no-mcp") disableMcp = true;
		else if (arg === "--session") {
			session = argv[++index];
			if (!session || session.startsWith("--"))
				throw new Error("--session requires a session directory or session.sqlite path");
		} else if (arg === "--extension" || arg === "-e") {
			const path = argv[++index];
			if (!path || path.startsWith("--")) throw new Error("--extension requires a trusted Durable adapter path");
			extensions.push(path);
		} else if (arg === "--mcp-server") {
			mcpOptionSeen = true;
			server = argv[++index];
		} else if (arg === "--mcp-tools") {
			mcpOptionSeen = true;
			tools = argv[++index]?.split(",");
		} else if (arg === "--mcp-agent") {
			mcpOptionSeen = true;
			agentName = argv[++index];
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (session && continueSession) throw new Error("Use --session PATH or --continue, not both");
	if (disableMcp && mcpOptionSeen) throw new Error("--no-mcp cannot be combined with MCP selection options");
	if (
		mcpOptionSeen &&
		(!server ||
			tools?.some((name) => !name) ||
			(server === "mcp-agent-mail" ? !agentName || tools !== undefined : !tools || agentName !== undefined))
	) {
		throw new Error(
			"Use --mcp-server NAME --mcp-tools TOOL[,TOOL...], or --mcp-server mcp-agent-mail --mcp-agent REGISTERED_NAME",
		);
	}
	return {
		continueSession,
		...(session ? { session } : {}),
		extensions,
		...(disableMcp
			? { mcp: false as const }
			: server
				? { mcp: { server, ...(tools ? { tools } : {}), ...(agentName ? { agentName } : {}) } }
				: {}),
	};
}

const argv = process.argv.slice(2);
const listenIndex = argv.indexOf("--listen");
let socketPath: string | undefined;
if (listenIndex !== -1) {
	socketPath = argv[listenIndex + 1];
	if (!socketPath || socketPath.startsWith("--")) throw new Error("--listen requires an absolute socket path");
	argv.splice(listenIndex, 2);
}
const durable = await openDurable(parseArgs(argv));
let shared: Awaited<ReturnType<typeof listenSharedHost>> | undefined;
try {
	if (socketPath) shared = await listenSharedHost(durable, socketPath);
	await runDurableTui(durable.view, durable.controller, durable.settings);
} finally {
	try { await shared?.close(); } finally { await durable.close(); }
}
