import type { TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { BBPlanStep, BBTasksSnapshotEvent } from "./bridge/contracts.ts";
import type { DurableViewSource } from "./runtime-types.ts";
import { taskLabel, TaskNames } from "./task-labels.ts";

const INDENT = "  ";

function statusOf(node: TaskGraphNode): BBPlanStep["status"] {
	const state = node.state;
	if (state.status === "running") return "active";
	// A completing task's own work is done; it only waits for the tasks it owns to drain.
	if (state.status === "completing") return state.outcome === "completed" ? "completed" : "failed";
	return "pending";
}

/**
 * The live task graph as one flat, ordered list: creation order, children nested under their owner.
 * The graph holds live tasks only, so this is what the daemon is working on right now.
 */
export function taskSteps(graph: TaskGraph, names?: TaskNames): BBPlanStep[] {
	const nodes = graph.tasks;
	const keys = Object.keys(nodes).sort((a, b) => Number(a) - Number(b));
	const children = new Map<string, string[]>();
	for (const key of keys) {
		const owner = nodes[key]?.owner;
		if (owner === undefined) continue;
		const siblings = children.get(String(owner));
		if (siblings === undefined) children.set(String(owner), [key]);
		else siblings.push(key);
	}

	const steps: BBPlanStep[] = [];
	const walk = (key: string, depth: number): void => {
		const node = nodes[key];
		if (node === undefined) return;
		steps.push({ step: INDENT.repeat(depth) + `#${key} ${taskLabel(node, names)}`, status: statusOf(node) });
		for (const child of children.get(key) ?? []) walk(child, depth + 1);
	};

	for (const key of keys) {
		const owner = nodes[key]?.owner;
		// An owner leaves the graph as soon as it is terminal, so a still-live child is walked as a root.
		if (owner === undefined || nodes[String(owner)] === undefined) walk(key, 0);
	}
	return steps;
}

/** Publishes the graph to BB whenever the panel would actually change; identical and empty snapshots are dropped. */
export function startTaskGraphBridge(
	view: DurableViewSource,
	output: (event: BBTasksSnapshotEvent) => void,
): void {
	const names = new TaskNames();
	let published = "";
	const publish = (): void => {
		const current = view.current();
		names.learn(current);
		const graph = current.tasks;
		const steps = graph === undefined ? [] : taskSteps(graph, names);
		const encoded = JSON.stringify(steps);
		if (steps.length === 0 || encoded === published) return;
		published = encoded;
		output({ type: "tasks_snapshot", steps });
	};
	view.subscribe(publish);
	publish();
}
