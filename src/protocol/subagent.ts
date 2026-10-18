import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
	configure, defineExtension, defineTool, type ConversationId, type Extension, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { SubagentsDoc, type SubagentRecord } from "./subagents/documents.ts";
import { courierFor } from "./subagents/delivery.ts";
import { Anchor, BACKGROUND, answerText, reporterFor, type SubagentAdmission } from "./subagents/tasks.ts";
export type { SubagentAdmission } from "./subagents/tasks.ts";

export type NativeChildRegistrationRequest = Readonly<{
	requestId: string;
	conversationId: ConversationId;
}>;

/** Runs only inside this tool's real public ToolExecutionApi/Context callback. */
export type NativeChildRegistration = (
	request: NativeChildRegistrationRequest,
	api: ToolExecutionApi,
	context: Context,
) => Promise<void>;

export type SubagentOptions = {
	maxActive?: number;
	/** Host-owned role allowlists; the model cannot grant tools it does not possess. */
	roles?: Record<string, readonly string[] | 'inherit'>;
	/** Optional native BB projection/persistence callback; never part of model arguments. */
	registerNativeChild?: NativeChildRegistration;
};

export function createSubagent(admit?: SubagentAdmission, options: SubagentOptions = {}): Extension {
	const maxActive = options.maxActive ?? 10;
	if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new Error("Invalid subagent admission limit");
	const Courier = courierFor(admit);
	const Reporter = reporterFor(Courier, admit);
	const extension: Extension = defineExtension({
		name: "subagent",
		tasks: [Anchor, Reporter, Courier],
		tools: [
			defineTool({
				name: "subagent",
				description: "Delegate an isolated task. Background by default: returns immediately and reports once. Use background:false to wait.",
				parameters: Type.Object({
					task: Type.String({ minLength: 1 }),
					name: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })),
					requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
					background: Type.Optional(Type.Boolean()),
					role: Type.Optional(Type.String()),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const key = `subagent:${args.requestId ?? api.taskId}`;
					const background = args.background !== false;
					const name = args.name ?? `child-${key}`;
					const role = args.role ?? "worker";
					const allowed = options.roles === undefined ? undefined :
						Object.hasOwn(options.roles, role) ? options.roles[role] : undefined;
					if (options.roles !== undefined && allowed === undefined) throw new Error(`Role not allowed: ${role}`);
					if (options.roles === undefined && role !== "worker") throw new Error(`Role not allowed: ${role}`);
					const parent = await api.agent(context);
					const tools = allowed === undefined || allowed === 'inherit' ? undefined : allowed.map((name) => {
						const tool = parent.tools.find((tool) => tool.name === name);
						if (!tool || name === "subagent" || name === "subagent_stop") throw new Error(`Role tool unavailable: ${name}`);
						return tool;
					});
					const record = await api.commit(async (tx) => {
						const state = await tx.doc(SubagentsDoc, api.conversationId);
						if (Object.hasOwn(state.agents, key)) {
							const existing = state.agents[key]!;
							if (existing.name !== name || existing.task !== args.task || existing.role !== role || existing.background !== background) {
								throw new Error("Subagent requestId conflicts with its original admission");
							}
							return { ...existing };
						}
						if (Object.values(state.agents).some((agent) => agent.name === name)) throw new Error(`Subagent name already exists: ${name}`);
						let active = 0;
						for (const agent of Object.values(state.agents)) {
							const task = await tx.task(agent.reporter ?? agent.ownerTaskId);
							if (task?.state.status !== "terminal") active++;
						}
						if (active >= maxActive) throw new Error("Subagent admission limit reached");
						const owner = background ? await tx.createTask(Anchor, null, BACKGROUND) : api.taskId;
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
						await configure(tx, child.id, { extensions: { remove: [extension] }, ...(tools === undefined ? {} : { tools }) });
						const record: SubagentRecord = { name, conversationId: child.id, requestId: `subagent:${owner}`,
							task: args.task, role, ownerTaskId: owner, background };
						// A registered native child must exist before Reporter can submit its first input.
						if (background && !options.registerNativeChild) record.reporter = await tx.createTask(Reporter, {
							key, conversationId: child.id, requestId: record.requestId, task: args.task,
						}, BACKGROUND);
						state.agents[key] = record;
						return record;
					}, context);
					if (options.registerNativeChild) {
						await options.registerNativeChild({ requestId: record.requestId, conversationId: record.conversationId }, api, context);
						if (record.background) {
							await api.commit(async (tx) => {
								const stored = (await tx.doc(SubagentsDoc, api.conversationId)).agents[key]!;
								if (stored.reporter === undefined) stored.reporter = await tx.createTask(Reporter, {
									key, conversationId: stored.conversationId, requestId: stored.requestId, task: stored.task,
								}, BACKGROUND);
							}, context);
						}
					}
					await api.details({ conversationId: record.conversationId, requestId: record.requestId,
						name: record.name, background: record.background }, context);
					if (record.background) return { output: [{ type: "text", text: `Started ${record.name}.` }] };
					const child = (await api.conversation(record.conversationId, context))!;
					await admit?.(child, record.requestId, context);
					const submission = await child.submit({ type: "input", content: args.task, requestId: record.requestId }, context);
					const settled = await submission.wait(context);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
					const text = await answerText(api, settled.answer, context);
					await api.commit(async (tx) => { (await tx.doc(SubagentsDoc, api.conversationId)).agents[key]!.settled = true; }, context);
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "subagent_release_hold", description: "Explicitly release a batch held before delivery. Returns the stored hold reason.",
				parameters: Type.Object({}), replay: "unsafe",
				execute: async (_args, api, context) => {
					const hold = await api.commit(async (tx) => {
						const state = await tx.doc(SubagentsDoc, api.conversationId);
						const held = state.deliveryHold;
						if (held === undefined) throw new Error("No subagent delivery hold is active");
					if (held.kind !== "admission") throw new Error(`Delivery outcome is uncertain; inspect the parent transcript before retrying: ${held.reason}`);
					const hold = { ...held };
					delete state.deliveryHold;
					return hold;
					}, context);
					return { output: [{ type: "text", text: `Released batch ${hold.requestId}; previous hold: ${hold.reason}` }] };
				},
			}),
			defineTool({
				name: "subagent_stop", description: "Stop only the named child owned by this conversation, not its siblings.",
				parameters: Type.Object({ name: Type.String() }), replay: "unsafe",
				execute: async (args, api, context) => {
					const state = await api.snapshot(SubagentsDoc, api.conversationId, context);
					const child = Object.values(state?.agents ?? {}).find((agent) => agent.name === args.name);
					if (!child) throw new Error(`No subagent named ${args.name}`);
					await (await api.conversation(child.conversationId, context))!.abort(context, { background: true });
					return { output: [{ type: "text", text: `Stopped ${child.name}.` }] };
				},
			}),
		],
	});
	return extension;
}
export const Subagent: Extension = createSubagent();
