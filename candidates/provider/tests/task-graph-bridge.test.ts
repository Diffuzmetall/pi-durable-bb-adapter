import test from "node:test";
import assert from "node:assert/strict";
import type { TaskGraph, TaskGraphNode, TaskGraphState } from "@earendil-works/pi-durable";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { taskSteps, startTaskGraphBridge } from "../src/runner/task-graph-bridge.ts";
import { TaskNames } from "../src/runner/task-labels.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { BBPlanStep } from "../src/runner/bridge/contracts.ts";
import type { DurableViewSource } from "../src/runner/runtime-types.ts";

function node(id: number, kind: string, state: TaskGraphState, owner?: number): TaskGraphNode {
	return {
		id,
		kind,
		conversationId: 1,
		...(owner === undefined ? {} : { owner }),
		background: false,
		abortRequested: false,
		state,
		conversations: [],
	} as unknown as TaskGraphNode;
}

function graph(tasks: Record<string, TaskGraphNode>): TaskGraph {
	return { tasks } as unknown as TaskGraph;
}


/** A view is only read for `pi.live` and the transcript, so a fixture needs no more than that. */
function liveView(live: unknown, entries: unknown[] = []): DurableView {
	return { conversation: { docs: { "pi.live": live }, entries } } as unknown as DurableView;
}

/** A model-issued call: its name is on the slot, its arguments are on the assistant entry. */
function runningCall(callId: string, name: string, taskId: number, args: Record<string, unknown>): DurableView {
	return liveView({
		tools: [{ callId, name, status: "running", taskId }],
		generation: { message: { content: [{ type: "toolCall", id: callId, arguments: args }] } },
	});
}

test("taskSteps: creation order with children nested under their owner", () => {
	const steps = taskSteps(
		graph({
			"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
			"2": node(2, "pi.generation", { status: "pending", phase: "prepare" }),
			"3": node(3, "pi.tool", { status: "running", phase: "execute" }, 1),
			"4": node(4, "pi.tool", { status: "pending", phase: "call" }, 1),
			"5": node(5, "pi.compaction", { status: "running", phase: "summarize" }, 3),
		}),
	);

	assert.deepEqual(steps, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #3 tool · execute", status: "active" },
		{ step: "    #5 compacting context", status: "active" },
		{ step: "  #4 tool · call", status: "pending" },
		{ step: "#2 assistant turn", status: "pending" },
	]);
});

test("taskSteps: waiting and completing states map onto the panel's four statuses", () => {
	const steps = taskSteps(
		graph({
			"1": node(1, "pi.generation", { status: "waiting", phase: "tools", on: [2 as never, 3 as never], policy: "allSettled" }),
			"2": node(2, "pi.tool", { status: "completing", outcome: "completed" }, 1),
			"3": node(3, "pi.tool", { status: "completing", outcome: "failed" }, 1),
		}),
	);

	assert.deepEqual(steps, [
		{ step: "#1 assistant turn · waiting on 2", status: "pending" },
		{ step: "  #2 tool · completing (completed)", status: "completed" },
		{ step: "  #3 tool · completing (failed)", status: "failed" },
	]);
});

test("taskSteps: keeps a live child whose owner already left the graph", () => {
	const steps = taskSteps(graph({ "7": node(7, "app.example", { status: "running", phase: "authorize" }, 6) }));

	assert.deepEqual(steps, [{ step: "#7 app.example · authorize", status: "active" }]);
});

test("taskSteps: an empty graph yields no rows", () => {
	assert.deepEqual(taskSteps(graph({})), []);
});

test("tasks_snapshot translates into a planSteps item that BB's schema accepts", () => {
	const steps: BBPlanStep[] = [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 bash: echo alpha", status: "completed" },
	];
	const deltas = new DeltaTranslator().translate({ type: "tasks_snapshot", steps }, { threadId: "thread-1" });

	assert.deepEqual(deltas.map((delta) => delta.kind), ["item.open", "item.close"]);
	for (const delta of deltas) {
		const parsed = threadDeltaSchema.safeParse(delta);
		assert.equal(parsed.success, true, `delta must validate against threadDeltaSchema: ${JSON.stringify(delta)}`);
		assert.equal((delta.key as { channel: string }).channel, "pi-durable-tasks");
	}

	const closed = deltas[1];
	assert.equal(closed.status, "completed");
	assert.deepEqual(closed.item, { type: "planSteps", steps });
});

test("tasks_snapshot without steps emits nothing", () => {
	assert.deepEqual(new DeltaTranslator().translate({ type: "tasks_snapshot", steps: [] }, { threadId: "thread-1" }), []);
});

test("startTaskGraphBridge publishes on change only", () => {
	let current: { tasks?: TaskGraph } = {};
	let notify: (() => void) | undefined;
	const view = {
		current: () => current,
		subscribe: (listener: () => void) => {
			notify = listener;
			return () => {
				notify = undefined;
			};
		},
	} as unknown as DurableViewSource;

	const emitted: BBPlanStep[][] = [];
	startTaskGraphBridge(view, (event) => emitted.push(event.steps));
	assert.equal(emitted.length, 0, "no graph yet means nothing to show");

	current = { tasks: graph({ "1": node(1, "pi.generation", { status: "running", phase: "request" }) }) };
	notify?.();
	assert.deepEqual(emitted, [[{ step: "#1 assistant turn", status: "active" }]]);

	notify?.();
	assert.equal(emitted.length, 1, "an unchanged graph must not re-emit");

	current = { tasks: graph({ "1": node(1, "pi.generation", { status: "pending", phase: "request" }) }) };
	notify?.();
	assert.equal(emitted.length, 2);
	assert.deepEqual(emitted[1], [{ step: "#1 assistant turn", status: "pending" }]);

	// A phase the panel does not show is not a change worth a new row.
	current = { tasks: graph({ "1": node(1, "pi.generation", { status: "pending", phase: "tools" }) }) };
	notify?.();
	assert.equal(emitted.length, 2, "a hidden phase change must not re-emit");

	current = {};
	notify?.();
	assert.equal(emitted.length, 2, "an empty graph leaves the last known panel in place");
});

test("taskNames: a tool task is named from the call the harness runs in it", () => {
	const names = new TaskNames();
	names.learn(runningCall("call-1", "bash", 3, { command: "echo alpha" }));

	assert.deepEqual(
		taskSteps(
			graph({
				"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
				"3": node(3, "pi.tool", { status: "running", phase: "execute" }, 1),
			}),
			names,
		),
		[
			{ step: "#1 assistant turn", status: "active" },
			{ step: "  #3 bash: echo alpha", status: "active" },
		],
	);
});

test("taskNames: a nested call names itself, a slot without a task names nothing, a learned name outlives its slot", () => {
	const names = new TaskNames();
	names.learn(
		liveView({
			// Not offered, so not started: there is no task to name yet.
			tools: [{ callId: "call-9", name: "bash", status: "pending" }],
			nestedTools: [
				{
					callId: "call-1/n1",
					name: "read",
					status: "running",
					taskId: 4,
					parentCallId: "call-1",
					parentTaskId: 3,
					arguments: { path: "src/runner/index.ts" },
				},
			],
		}),
	);

	const waiting: TaskGraphState = { status: "waiting", phase: "execute", on: [5 as never], policy: "allSettled" };
	assert.deepEqual(taskSteps(graph({ "4": node(4, "pi.tool", waiting) }), names), [
		{ step: "#4 read: src/runner/index.ts · waiting on 1", status: "pending" },
	]);

	// The slot leaves pi.live when the call ends, and the name it taught stays.
	names.learn(liveView({ tools: [] }));
	assert.deepEqual(taskSteps(graph({ "4": node(4, "pi.tool", { status: "completing", outcome: "completed" }) }), names), [
		{ step: "#4 read: src/runner/index.ts · completing (completed)", status: "completed" },
	]);
	assert.deepEqual(taskSteps(graph({ "5": node(5, "pi.tool", { status: "running", phase: "execute" }) }), names), [
		{ step: "#5 tool · execute", status: "active" },
	]);
});

test("taskNames: a name is one bounded line, and no registry changes nothing", () => {
	const names = new TaskNames();
	names.learn(
		runningCall("call-1", "bash", 3, {
			command: "  git log\n  --oneline --decorate --all --graph --stat --pretty=format:%H  ",
		}),
	);

	const tasks = graph({ "3": node(3, "pi.tool", { status: "running", phase: "execute" }) });
	const [step] = taskSteps(tasks, names);
	assert.ok(step !== undefined);
	assert.ok(step.step.startsWith("#3 bash: git log --oneline"), step.step);
	assert.equal(step.step.endsWith("…"), true, "a long command is clipped");
	assert.equal(step.step.includes("\n"), false, "a multi-line command stays on one line");
	assert.equal(step.step.length, 3 + 48, "the name is bounded");

	assert.deepEqual(taskSteps(tasks), [{ step: "#3 tool · execute", status: "active" }]);
});
