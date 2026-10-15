import type { Extension } from "@earendil-works/pi-durable";
import { createMcpCodemodeExtension } from "@earendil-works/pi-durable/mcp-codemode";
import { McpClient } from "@earendil-works/pi-mcp";
import { getAgentDir, VERSION } from "../../config.ts";
import { loadMcpConfig } from "../../extensions/mcp/config.ts";
import { createDefaultTransport } from "../../extensions/mcp/runtime.ts";

export { openConfiguredDurableMcp } from "../../../../../.pi/extensions/durable-mcp/index.ts";

export interface DurableMcpSelection {
	readonly server: string;
	readonly tools?: readonly string[];
	/** Registered Agent Mail identity of this Durable session; required for Agent Mail. */
	readonly agentName?: string;
}

/** One opt-in connection; neither the MCP config nor the host's credentials are modified. */
export async function openDurableMcp(
	selection: DurableMcpSelection,
	cwd: string,
	options: { readonly agentDir?: string } = {},
): Promise<{ extension: Extension; close(): Promise<void> }> {
	const loaded = loadMcpConfig({ agentDir: options.agentDir ?? getAgentDir(), cwd, projectTrusted: false });
	const entry = loaded.servers.find((item) => item.name === selection.server);
	if (!entry || entry.config.enabled === false)
		throw new Error(`MCP server "${selection.server}" is absent or disabled`);
	// OAuth and provider-auth flows need interactive login; reuse explicit headers and stdio config only.
	if ("url" in entry.config && (entry.config.oauth || entry.config.auth)) {
		throw new Error("Durable MCP does not yet support OAuth or provider-auth MCP servers");
	}
	const mail = entry.name === "mcp-agent-mail";
	if (mail && !selection.agentName) throw new Error("Agent Mail requires --mcp-agent NAME");
	if (!mail && !selection.tools?.length) throw new Error("Specify the MCP tools to expose");
	const client = new McpClient({
		name: "pi-durable",
		version: VERSION,
		requestTimeoutMs: (entry.config.timeout ?? 60) * 1000,
	});
	try {
		await client.connect(createDefaultTransport(entry, cwd, undefined));
		const available = await client.listTools();
		const allowedTools = mail ? available.map((tool) => tool.name) : selection.tools!;
		const extension = await createMcpCodemodeExtension({
			client,
			server: entry.name,
			allowedTools,
			// Agent Mail has one model-facing entry point: codemode discovers and calls all server tools.
			directTools: mail ? [] : undefined,
			authorize: (tool, args) => {
				if (mail) authorizeAgentMail(tool.name, args, cwd, selection.agentName!);
				else if (tool.annotations?.readOnlyHint !== true)
					throw new Error(`MCP tool ${tool.name} is not declared read-only`);
			},
		});
		return { extension, close: () => client.close() };
	} catch (error) {
		await client.close();
		throw error;
	}
}

/** Agent Mail is a privileged data/write surface: bind every call to this session's project and actor. */
export function authorizeAgentMail(name: string, args: Record<string, unknown>, project: string, agent: string): void {
	if (args.project_key !== undefined && args.project_key !== project) throw new Error("Agent Mail project mismatch");
	if (args.human_key !== undefined && args.human_key !== project) throw new Error("Agent Mail project mismatch");
	const actor: Record<string, string> = {
		register_agent: "name",
		send_message: "sender_name",
		reply_message: "sender_name",
		request_contact: "from_agent",
		respond_contact: "to_agent",
		macro_start_session: "agent_name",
		macro_prepare_thread: "agent_name",
		macro_file_reservation_cycle: "agent_name",
		macro_contact_handshake: "agent_name",
		fetch_inbox: "agent_name",
		fetch_inbox_events: "agent_name",
		mark_all_read: "agent_name",
		mark_message_read: "agent_name",
		acknowledge_message: "agent_name",
		list_contacts: "agent_name",
		set_contact_policy: "agent_name",
		unretire_agent: "agent_name",
		acquire_build_slot: "agent_name",
		renew_build_slot: "agent_name",
		release_build_slot: "agent_name",
		file_reservation_paths: "agent_name",
		release_file_reservations: "agent_name",
		renew_file_reservations: "agent_name",
		check_file_reservation_conflicts: "agent_name",
		fetch_inbox_product: "agent_name",
		retire_agent: "agent_name",
		deregister_agent: "agent_name",
		force_release_file_reservation: "agent_name",
	};
	const key = actor[name];
	if (key && args[key] !== agent) throw new Error(`Agent Mail identity mismatch: ${key} must be ${agent}`);
	// Durable has no interactive permission gate for these administrative/destructive operations yet.
	if (
		[
			"deregister_agent",
			"force_release_file_reservation",
			"cleanup_pane_identities",
			"install_precommit_guard",
			"uninstall_precommit_guard",
			"retire_agent",
			"create_agent_identity",
		].includes(name)
	) {
		throw new Error(`Agent Mail ${name} requires separate operator approval`);
	}
}
