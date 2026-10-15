// Durable registry adapter for the Hindsight extension.
//
// The Durable host treats every path in `extensions` as a *trusted registry adapter*, not as a
// Pi ExtensionAPI plugin: .pi/extensions/durable-reload/index.ts loads it with
// `jiti.import(path, { default: true })` and requires
//
//     DurableRegistryAdapter = (registry: RegistryReader) => RegistryReader | Promise<RegistryReader>
//
// i.e. the default export must be a function that receives the current registry and returns an
// object with `snapshot()` and `subscribe()`. hindsight/extension.mjs exports
// `createHindsightExtension(...)`, an *Extension object* (defineExtension), not such a factory, so
// pointing the host straight at extension.mjs fails with "must export a default registry adapter".
//
// This adapter mirrors the playground controller (pi-durable-playground/hindsight/index.mjs):
//
//     const controller = createHindsightController(registry, { resolveBinding, resolveClient });
//     controller.bind({ session, storage, directory, context });
//
// `createHindsightController` installs both the extension and the `hindsight.deliver` task, and
// owns the host-bound `getHost`/`buildContext`/`lifecycleFor` closures that make the pinned
// `hindsight_memory` section and the delivery/reconcile lane live. The controller cannot bind
// itself: the live Harness, storage and session directory are only known after `Harness.open`.
// The host runtime therefore reads the controller back off the registry through the shared
// `Symbol.for` key below, calls `bind` after open, and `drain`/`close` on shutdown. A relative
// `.mjs` import is not type-checkable from the host's TypeScript, so the registry object is the
// hand-off channel.
//
// The factory itself starts no external resources and reads no config; binding, context building
// and delivery stay deferred to the bound host. If controller construction fails, the adapter logs
// and returns the registry unchanged so an optional memory backend never blocks the host.

import { resolve } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { resolveHostMemory, resolvePiConfig } from "./bridge.mjs";
import { createHindsightController } from "./index.mjs";

/** Shared cross-module key; runtime.ts looks up the same `Symbol.for` value on the registry. */
export const HINDSIGHT_CONTROLLER = Symbol.for("pi.durable.hindsight.controller");


export default async function installHindsightAdapter(registry) {
	if (!registry || typeof registry.install !== "function") {
		throw new Error("Hindsight adapter requires a Durable registry with install()");
	}
	const base = registry;
	registry = createRegistry();
	for (const extension of base.snapshot().installed()) registry.install(extension);
	const existing = base[HINDSIGHT_CONTROLLER];
	if (existing) {
		// /reload re-runs this factory. Keep the bound controller and let it reinstall fresh
		// extension code, so the live host binding and its commit subscription survive.
		await existing.reload(registry);
		Object.defineProperty(registry.snapshot().extension("hindsight"), HINDSIGHT_CONTROLLER, { value: existing });
		return registry;
	}
	const resolveBinding = resolvePiConfig;
	const resolveClient = async (binding) => resolveHostMemory("pi", binding.cwd).client;
	let controller;
	try {
		controller = createHindsightController(registry, { resolveBinding, resolveClient, diagnostic: (notice) => console.warn(notice) });
	} catch {
		console.error("Hindsight disabled: adapter initialization failed");
		return registry;
	}
	// Defaults only: explicit environment overrides win, and the first bound
	// host sets process-wide paths reused by later hosts. This pinned API cannot
	// isolate concurrent hosts in one process; do not overwrite user overrides.
	const bind = controller.bind;
	controller.bind = async (host) => {
		process.env.HINDSIGHT_LOG_FILE ??= resolve(host.directory, "memory.log");
		process.env.HINDSIGHT_DIAG_FILE ??= resolve(host.directory, "diagnostics.jsonl");
		process.env.HINDSIGHT_USAGE_FILE ??= resolve(host.directory, "usage.jsonl");
		return bind.call(controller, host);
	};
	Object.defineProperty(registry.snapshot().extension("hindsight"), HINDSIGHT_CONTROLLER, {
		value: controller,
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return registry;
}
