import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness, RegistryReader } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import * as tools from "@earendil-works/pi-durable/tools";
import { createJiti } from "jiti";

/** Trusted Durable registry adapter, not Pi ExtensionAPI. Factories must not start external resources. */
export type DurableRegistryAdapter = (registry: RegistryReader) => RegistryReader | Promise<RegistryReader>;

/** Stable Harness registry facade: prepare a fresh candidate, then publish only while globally idle. */
export class DurableExtensions implements RegistryReader {
	readonly #base: RegistryReader;
	readonly #cwd: string;
	readonly #listeners = new Set<() => void>();
	#current: RegistryReader;
	#paths: readonly string[];
	#reloading = false;

	constructor(base: RegistryReader, cwd: string, paths: readonly string[] = []) {
		this.#base = base;
		this.#current = base;
		this.#cwd = cwd;
		this.#paths = paths.map((path) => resolve(cwd, path));
	}

	snapshot(): ReturnType<RegistryReader["snapshot"]> { return this.#current.snapshot(); }
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		const unsubscribe = this.#base.subscribe(listener);
		return () => { this.#listeners.delete(listener); unsubscribe(); };
	}

	async reloadWhenIdle(harness: Pick<Harness, "taskGraph">, context: Context, path?: string): Promise<number> {
		return this.reload(async () => {
			const graph = await harness.taskGraph(context);
			try {
				if (Object.keys(graph.value.tasks).length > 0) throw new Error("Cannot reload while tasks are active; wait or abort them first");
			} finally { graph.dispose(); }
		}, path);
	}

	async reload(assertIdle: () => Promise<void>, additionalPath?: string): Promise<number> {
		if (this.#reloading) throw new Error("A Durable reload is already in progress");
		this.#reloading = true;
		try {
			await assertIdle();
			const paths = [...new Set([...this.#paths, ...(additionalPath ? [resolve(this.#cwd, additionalPath)] : [])])];
			const jiti = createJiti(import.meta.url, {
				moduleCache: false, fsCache: false, tryNative: false,
				virtualModules: { "@earendil-works/pi-durable": durable, "@earendil-works/pi-durable/tools": tools },
			});
			let candidate = this.#base;
			for (const path of paths) {
				const factory = await jiti.import<DurableRegistryAdapter>(path, { default: true });
				if (typeof factory !== "function") throw new Error(`Durable extension ${path} must export a default registry adapter`);
				candidate = await factory(candidate);
				if (!candidate || typeof candidate.snapshot !== "function" || typeof candidate.subscribe !== "function") throw new Error(`Durable extension ${path} did not return a registry reader`);
			}
			const snapshot = candidate.snapshot();
			const names = new Set<string>();
			for (const { tool } of snapshot.tools()) {
				if (names.has(tool.name)) throw new Error(`Duplicate tool after reload: ${tool.name}`);
				names.add(tool.name);
			}
			for (const task of this.#base.snapshot().tasks()) {
				if (!snapshot.task(task.definition.name)) throw new Error(`Reload removed task ${task.definition.name}`);
			}
			await assertIdle();
			this.#current = candidate;
			this.#paths = paths;
			for (const listener of this.#listeners) listener();
			return paths.length;
		} finally { this.#reloading = false; }
	}
}
