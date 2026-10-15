import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { createMultiMcpCodemodeExtension, type McpCodemodeOptions } from "@earendil-works/pi-durable/mcp-codemode";
import { Type } from "@earendil-works/pi-ai";
import { type CallToolResult } from "@earendil-works/pi-mcp";
import { getAgentDir } from "../../../packages/coding-agent/src/config.ts";
import { getMcpToolExposure, loadMcpConfig } from "../../../packages/coding-agent/src/extensions/mcp/config.ts";
import { createDefaultTransport, McpServerConnection, McpOAuthCredentialStore } from "../../../packages/coding-agent/src/extensions/mcp/runtime.ts";
import { authorizeAgentMail } from "../../../packages/coding-agent/src/experimental/durable/mcp.ts";

export interface DurableMcpStatus { readonly server: string; readonly state: string; readonly tools: number; }
interface MailIdentity { project: string; name: string; token?: string; }
function jsonResult(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error("Agent Mail identity setup failed");
	if (result.structuredContent) return result.structuredContent;
	const text = result.content.find((item) => item.type === "text");
	if (!text || text.type !== "text") throw new Error("Agent Mail identity response missing");
	return JSON.parse(text.text) as Record<string, unknown>;
}

/** Session-owned connections to every enabled USER-configured server. Disabled servers stay disabled. */
export async function openConfiguredDurableMcp(cwd: string, options: {
	readonly agentDir?: string;
	readonly sessionDirectory?: string;
	readonly agentName?: string;
	readonly servers?: readonly string[];
	readonly initializeMail?: boolean;
	readonly providerToken?: (provider: string) => Promise<string | undefined>;
	readonly onMailIdentity?: (name: string, project: string) => void;
} = {}): Promise<{ extension: Extension; status(): DurableMcpStatus[]; close(): Promise<void> }> {
	const loaded = loadMcpConfig({ agentDir: options.agentDir ?? getAgentDir(), cwd, projectTrusted: false });
	if (loaded.errors.length) throw new Error("MCP configuration is invalid; inspect mcp.json locally");
	const credentials = new McpOAuthCredentialStore();
	const connections: McpServerConnection[] = [];
	const entries = loaded.servers.filter((entry) => entry.config.enabled !== false && (!options.servers || options.servers.includes(entry.name)));
	let identity: MailIdentity | undefined;
	const sources: McpCodemodeOptions[] = [];
	const status = () => connections.map((connection) => ({ server: connection.name, state: connection.state, tools: connection.tools.length }));
	try {
		await Promise.all(entries.map(async (entry) => {
			const connection = new McpServerConnection({ entry, cwd, credentials, createTransport: createDefaultTransport, providerToken: options.providerToken, onTools: () => {} });
			connections.push(connection);
			try {
				await connection.getClient();
				if (entry.name === "mcp-agent-mail") {
					identity = { project: cwd, name: options.agentName ?? process.env.AGENT_MAIL_AGENT ?? "" };
					const file = options.sessionDirectory ? join(options.sessionDirectory, "agent-mail-identity.json") : undefined;
					if (file) {
						try {
							const saved = JSON.parse(await readFile(file, "utf8")) as MailIdentity;
							if (saved.project === cwd && typeof saved.name === "string" && (!identity.name || saved.name === identity.name)) identity = saved;
						} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid saved Agent Mail identity"); }
					}
					if (options.initializeMail !== false && connection.tools.some((tool) => tool.name === "register_agent")) {
						const ensured = await connection.callTool("ensure_project", {human_key:cwd}, {});
						if (ensured.isError) throw new Error("Agent Mail project setup failed");
						const registered = jsonResult(await connection.callTool("register_agent", {project_key:cwd,program:"pi-durable",model:"current-runtime",...(identity.name ? {name:identity.name} : {}),...(identity.token ? {registration_proof:identity.token} : {})}, {}));
						if (typeof registered.name !== "string") throw new Error("Agent Mail returned no session identity");
						identity = {project:cwd,name:registered.name,...(typeof registered.registration_token === "string" ? {token:registered.registration_token} : {})};
						if (file) await writeFile(file, JSON.stringify(identity), {mode:0o600});
					}
					if (identity.name) options.onMailIdentity?.(identity.name, cwd);
				}
				if (!connection.tools.length) return;
				sources.push({
					server: entry.name,
					client: { listTools: async () => connection.tools, callTool: (name, args, request) => connection.callTool(name, args ?? {}, request ?? {}) },
					allowedTools: connection.tools.filter((tool) => getMcpToolExposure(entry.config, tool.name) !== "hidden").map((tool) => tool.name),
					directTools: [],
					authorize: (tool, args) => {
						if (entry.name !== "mcp-agent-mail") return;
						const actor = identity?.name;
						if (!actor) throw new Error("Agent Mail identity is unavailable; reconnect the session");
						authorizeAgentMail(tool.name, args, cwd, actor);
						if (identity?.token && (tool.name === "send_message" || tool.name === "reply_message")) args.sender_token = identity.token;
					},
				});
			} catch {
				// Do not print config values, stdio stderr, URLs, headers, or registration credentials.
				// The connection state provides a safe distinction between auth, transport and identity failures.
				if (connection.state === "connected") connection.state = "failed";
			}
		}));
		const admitted = sources.filter((source) => source.allowedTools.length > 0);
		const combined = await createMultiMcpCodemodeExtension(admitted, "configured-mcp");
		const statusTool = defineTool({
			name: "mcp_status", description: "Show actual MCP connection states, tool counts, and this session's Agent Mail identity. No credentials are included.",
			parameters: Type.Object({}), replay: "safe",
			execute: async () => ({output:[{type:"text",text:JSON.stringify({servers:status(),agentMail:identity?.name ? {project:cwd,name:identity.name} : null})}]}),
		});
		return {extension:defineExtension({...combined,tools:[...(combined.tools ?? []),statusTool]}),status,close:async()=>{await Promise.all(connections.map(connection=>connection.close()));}};
	} catch (error) {
		await Promise.all(connections.map(connection=>connection.close()));
		throw error;
	}
}
