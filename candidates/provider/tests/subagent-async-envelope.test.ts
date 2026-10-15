import test from "node:test";
import assert from "node:assert/strict";
import { Subagent, buildRoleEnvelope } from "../src/runner/subagent.ts";

test("buildRoleEnvelope creates a focused, non-meta instruction envelope", () => {
	const task = "Audit authentication routes";
	const envelope = buildRoleEnvelope(task);

	assert.ok(envelope.includes("isolated worker subagent"));
	assert.ok(envelope.includes(task));
	assert.ok(envelope.includes("Do not attempt repository-wide meta-discovery"));
});

test("Subagent tool parameters accept task and optional background flag", () => {
	const tool = Subagent.tools[0];
	assert.equal(tool.name, "subagent");
	const props = (tool.parameters as any).properties;
	assert.ok(props.task, "task property must exist");
	assert.ok(props.background, "background property must exist");
});

test("Subagent tool in background mode returns immediately without waiting for completion", async () => {
	const tool = Subagent.tools[0];
	let configuredInstructions: string | undefined;
	let removedExtensions: any[] | undefined;
	let submittedContent: string | undefined;
	let waitCalled = false;
	let reportedDetails: any;

	const mockApi: any = {
		taskId: "task_parent_1",
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_99" }),
				doc: async () => ({}),
			};
			return fn(mockTx);
		},
		details: async (val: any) => {
			reportedDetails = val;
		},
		conversation: async (_id: string) => ({
			submit: async (req: any) => {
				submittedContent = req.content;
				return {
					wait: async () => {
						waitCalled = true;
						return { status: "done", type: "input", answer: "ans_1" };
					},
				};
			},
		}),
	};

	// Override configure in test scope via mock or spy
	const result = await tool.execute(
		{ task: "Do fast background job", background: true },
		mockApi,
		{} as any,
	);

	assert.equal(waitCalled, false, "Background subagent must NOT wait synchronously");
	assert.ok(result.output[0].text.includes("Subagent spawned in background"));
	assert.equal(reportedDetails.conversationId, "conv_child_99");
	assert.equal(reportedDetails.background, true);
	assert.equal(submittedContent, "Do fast background job");
});

test("Subagent tool in foreground mode (background: false) waits for child completion", async () => {
	const tool = Subagent.tools[0];
	let waitCalled = false;

	const mockApi: any = {
		taskId: "task_parent_2",
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_100" }),
				doc: async () => ({}),
				entry: async () => ({
					model: [{ role: "assistant", content: [{ type: "text", text: "Foreground finished" }] }],
				}),
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async (_id: string) => ({
			submit: async () => ({
				wait: async () => {
					waitCalled = true;
					return { status: "done", type: "input", answer: "ans_2" };
				},
			}),
		}),
	};

	const result = await tool.execute(
		{ task: "Run synchronous calculation", background: false },
		mockApi,
		{} as any,
	);

	assert.equal(waitCalled, true, "Foreground subagent must wait synchronously");
	assert.equal(result.output[0].text, "Foreground finished");
});

test("Subagent tool execution returns output property according to Durable 1.2.0 contract", async () => {
	const tool = Subagent.tools[0];
	assert.ok(tool, "Subagent tool must exist");
	const mockApi: any = {
		taskId: "task_test_subagent_output",
		commit: async (fn: any) => fn({
			scanConversations: async () => ({ items: [] }),
			createConversation: async () => ({ id: "conv_child_output_test" }),
			doc: async () => ({}),
			entry: async () => ({ model: [{ content: [{ type: "text", text: "Child solved task" }] }] }),
		}),
		details: async () => {},
		conversation: async () => ({
			submit: async () => ({
				wait: async () => ({ status: "done", type: "input", answer: "entry_123" }),
			}),
		}),
	};
	const res = await tool.execute({ task: "Compute 2+2", background: false }, mockApi, {} as any);
	assert.ok(Array.isArray(res.output), "Must return output array");
	assert.strictEqual((res as any).content, undefined, "content property must not be present");
});
