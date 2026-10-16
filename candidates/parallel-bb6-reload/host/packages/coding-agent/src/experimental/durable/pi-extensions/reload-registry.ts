import { createRegistry } from "@earendil-works/pi-durable";
import type { RegistryReader, ToolRegistration } from "@earendil-works/pi-durable";
import type { AdmittedResource, CatalogEntry, NativeOwners } from "./catalog.ts";

interface LoadedPiExtension {
	readonly name: string;
	readonly resolvedPath: string;
	readonly tools: ReadonlyMap<string, { readonly definition: unknown }>;
}

interface LoadedPiResources {
	readonly catalog: readonly CatalogEntry[];
	readonly extensions: readonly LoadedPiExtension[];
}

export type PiResourceLoader = (
	cwd: string,
	options: { agentDir: string; resources: readonly AdmittedResource[]; nativeOwners: NativeOwners },
) => Promise<LoadedPiResources>;
export type PiRegistrationFactory = (definition: unknown) => ToolRegistration;

/** Prepare a whole Pi-derived reader without publishing it or mutating the startup Registry. */
export function createPiRegistryPreparer(options: {
	cwd: string;
	agentDir: string;
	resources: readonly AdmittedResource[];
	previousPiExtensionNames: readonly string[];
}, load: PiResourceLoader, register: PiRegistrationFactory): (base: RegistryReader) => Promise<RegistryReader> {
	return async (base) => {
		const previousPiOwners = new Set(options.previousPiExtensionNames);
		const baseSnapshot = base.snapshot();
		const nativeOwners: NativeOwners = {
			tools: baseSnapshot.tools().filter(({ extension }) => !previousPiOwners.has(extension.name)).map(({ tool }) => tool.name),
			commands: [],
			flags: [],
		};
		const loaded = await load(options.cwd, {
			agentDir: options.agentDir,
			resources: options.resources,
			nativeOwners,
		});
		const refused = loaded.catalog.filter((entry) => ["refused", "failed", "conflict"].includes(entry.status));
		if (refused.length) {
			throw new Error(`Pi candidate rejected: ${refused.map((entry) => `${entry.path}: ${entry.status} (${entry.errors.join("; ")})`).join(" | ")}`);
		}

		const candidate = createRegistry();
		const owners = new Set<string>();
		for (const extension of baseSnapshot.installed()) {
			if (previousPiOwners.has(extension.name)) continue;
			candidate.install(extension);
			owners.add(extension.name);
		}
		for (const extension of loaded.extensions) {
			if (owners.has(extension.name)) throw new Error(`Pi candidate extension name already owned: ${extension.name}`);
			const tools = [...extension.tools.values()].map(({ definition }) => register(definition));
			if (tools.length === 0) throw new Error(`Pi candidate extension ${extension.name} has no supported tools`);
			candidate.install({ name: extension.name, tools });
			owners.add(extension.name);
		}
		return candidate;
	};
}
