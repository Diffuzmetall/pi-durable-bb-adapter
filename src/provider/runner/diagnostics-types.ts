export const SUPPORTED_EXTENSION_HOOKS = new Set([
	"session_start",
	"session_shutdown",
	"before_agent_start",
	"tool_call",
	"tool_result",
]);

export interface PiPathStatus {
	path: string;
	exists: boolean;
	type: "file" | "directory";
	required: boolean;
}

export interface ExtensionDiagnostic {
	path: string;
	resolvedPath: string;
	tools: string[];
	commands: string[];
	supportedHooks: string[];
	unsupportedHooks: string[];
}

export interface PiDiagnosticsReport {
	version: string;
	durableVersion: string;
	agentDir: string;
	paths: Record<string, PiPathStatus>;
	settings: {
		defaultProvider?: string;
		defaultModel?: string;
		thinkingLevel?: string;
		packages: string[];
		extensions: string[];
	};
	models: {
		total: number;
		providers: string[];
		defaultModelAvailable: boolean;
	};
	extensions: {
		total: number;
		errors: Array<{ path: string; error: string }>;
		warnings: Array<{ path: string; warning: string }>;
		items: ExtensionDiagnostic[];
	};
	skills: {
		total: number;
		sample: string[];
	};
	tools: {
		total: number;
		system: string[];
		custom: string[];
		mcp: string[];
	};
	status: "healthy" | "warning" | "error";
	summary: string;
}
