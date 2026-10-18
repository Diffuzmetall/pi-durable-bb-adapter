import type { ModelCatalog } from "./catalog.ts";
import {
	getProviderInstallationStatus,
	getProviderInstallationRun,
} from "./installation-manager.ts";
import {
	PROVIDER_BRIDGE_PROTOCOL_VERSION,
	THREAD_DELTA_GRAMMAR_V2,
	THREAD_DELTA_GRAMMAR_V3,
} from "./types.ts";

export async function handleDiscoveryRequest(
	method: string,
	params: unknown,
	catalog: ModelCatalog,
): Promise<Record<string, unknown> | null> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
				capabilities: {
					sessionRestore: true,
					threadArchive: false,
					threadRename: false,
					threadGoalClear: false,
					fork: "checkpoint",
					approvalEnforcedBy: "runtime",
					grammarVersions: [THREAD_DELTA_GRAMMAR_V2, THREAD_DELTA_GRAMMAR_V3],
					steerMode: "inject",
					skills: { configure: true },
				},
			};

		case "model/list": {
			const models = await catalog.listModels();
			return { models, selectedOnlyModels: [] };
		}

		case "provider/health": {
			const health = await catalog.getHealth();
			return health as Record<string, unknown>;
		}

		case "provider/diagnostics": {
			const diagnostics = await catalog.getDiagnostics();
			return diagnostics as unknown as Record<string, unknown>;
		}

		case "provider/usage":
			return { supported: false };

		case "provider/installation/status": {
			const statusParams = typeof params === "object" && params !== null
				? (params as { checkUpdates?: boolean })
				: {};
			const status = await getProviderInstallationStatus(statusParams);
			return status as unknown as Record<string, unknown>;
		}

		case "provider/installation/run": {
			const runParams = typeof params === "object" && params !== null
				? (params as { action?: "install" | "update" })
				: {};
			const action = runParams.action ?? "update";
			const runResult = await getProviderInstallationRun(action);
			return runResult as unknown as Record<string, unknown>;
		}

		default:
			return null;
	}
}
