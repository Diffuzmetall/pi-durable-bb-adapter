import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../../package.json" with { type: "json" };

export interface ProviderInstallationAction { kind: "install" | "update"; label: "Install" | "Update"; command: string; }
export type ProviderInstallationSource = "notInstalled" | "npmGlobal" | "external";

export interface ProviderInstallationStatus {
	executableName: string;
	executablePath: string | null;
	installed: boolean;
	installSource: ProviderInstallationSource;
	currentVersion: string | null;
	latestVersion: string | null;
	minimumSupportedVersion: string | null;
	npmPackageName: string | null;
	npmGlobalPackageVersion: string | null;
	installAction: ProviderInstallationAction | null;
	needsUpdate: boolean;
	versionUnsupported: boolean;
}

export type ProviderInstallationRunResult =
	| {
			available: true;
			command: { command: string; args: string[]; displayCommand: string };
			verification:
				| { kind: "installed" }
				| { kind: "version_changed"; previousVersion: string }
				| { kind: "version_at_least"; version: string };
	  }
	| { available: false; message: string };

const PLUGIN_PACKAGE_NAME = "bb-plugin-provider-pi-durable";
const PLUGIN_EXECUTABLE_NAME = "bb";
const MINIMUM_SUPPORTED_VERSION = "0.2.0";

// Baked into the bundle at build time. bb deploys the host bundle on its own as
// <dataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs, with no package.json
// anywhere near it, so the filesystem scan below cannot see the version at runtime.
// The bundled value is the version of the code that is actually running.
const BUNDLED_PLUGIN_VERSION =
	typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "";

let cachedPluginVersion: string | null = null;
let cachedLatestVersion: { version: string; fetchedAt: number } | null = null;
const LATEST_CACHE_TTL_MS = 60000;

export function resolvePluginVersion(): string {
	if (cachedPluginVersion !== null) return cachedPluginVersion;
	if (BUNDLED_PLUGIN_VERSION.length > 0) return (cachedPluginVersion = BUNDLED_PLUGIN_VERSION);
	try {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			join(currentDir, "..", "..", "package.json"),
			join(currentDir, "..", "package.json"),
			join(process.cwd(), "package.json"),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
				if (parsed.name === PLUGIN_PACKAGE_NAME && typeof parsed.version === "string" && parsed.version.length > 0) {
					return (cachedPluginVersion = parsed.version);
				}
			}
		}
	} catch (err) {
		console.warn(`[InstallationManager] Failed to read package.json version: ${err instanceof Error ? err.message : String(err)}`);
	}
	return (cachedPluginVersion = "0.0.0-unknown");
}

export function resetPluginVersionCacheForTesting(): void {
	cachedPluginVersion = null;
	cachedLatestVersion = null;
}

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(part => parseInt(part, 10) || 0);
	const pb = b.split(".").map(part => parseInt(part, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

async function fetchJsonWithTimeout<T>(url: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<T | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		const res = await fetchFn(url, { signal: controller.signal, headers }).finally(() => clearTimeout(timer));
		if (res.ok) return (await res.json()) as T;
		console.warn(`[InstallationManager] HTTP ${res.status} ${res.statusText} for ${url}`);
	} catch (err) {
		console.warn(`[InstallationManager] Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return null;
}

async function fetchRemoteLatest(packageName: string, fetchFn: typeof fetch): Promise<string | null> {
	const tags = await fetchJsonWithTimeout<Array<{ name?: string }>>(
		`https://api.github.com/repos/VanDalkvist/${packageName}/tags`,
		{ Accept: "application/vnd.github+json", "User-Agent": packageName },
		fetchFn,
	);
	if (Array.isArray(tags)) {
		let max: string | null = null;
		for (const item of tags) {
			const tag = item?.name?.replace(/^v/, "");
			if (tag && /^\d+\.\d+\.\d+/.test(tag) && (max === null || compareSemver(tag, max) > 0)) max = tag;
		}
		if (max !== null) return max;
	}
	const npm = await fetchJsonWithTimeout<{ "dist-tags"?: { latest?: string } }>(
		`https://registry.npmjs.org/${packageName}`,
		{ Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
		fetchFn,
	);
	return typeof npm?.["dist-tags"]?.latest === "string" ? npm["dist-tags"].latest : null;
}

export async function fetchLatestVersion(
	packageName = PLUGIN_PACKAGE_NAME,
	fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
	const now = Date.now();
	if (cachedLatestVersion !== null && now - cachedLatestVersion.fetchedAt < LATEST_CACHE_TTL_MS) {
		return cachedLatestVersion.version;
	}
	const currentVersion = resolvePluginVersion();
	const remoteLatest = await fetchRemoteLatest(packageName, fetchFn);
	const resolved =
		remoteLatest !== null && compareSemver(remoteLatest, currentVersion) > 0
			? remoteLatest
			: currentVersion;

	cachedLatestVersion = { version: resolved, fetchedAt: now };
	return resolved;
}

export async function getProviderInstallationStatus(
	options: { checkUpdates?: boolean; fetchFn?: typeof fetch } = {},
): Promise<ProviderInstallationStatus> {
	const currentVersion = resolvePluginVersion();
	const latestVersion =
		options.checkUpdates !== false
			? await fetchLatestVersion(PLUGIN_PACKAGE_NAME, options.fetchFn)
			: null;
	const needsUpdate =
		latestVersion !== null && compareSemver(latestVersion, currentVersion) > 0;
	const versionUnsupported =
		MINIMUM_SUPPORTED_VERSION !== null &&
		compareSemver(currentVersion, MINIMUM_SUPPORTED_VERSION) < 0;

	return {
		executableName: PLUGIN_EXECUTABLE_NAME,
		executablePath: process.execPath,
		installed: true,
		installSource: "external",
		currentVersion,
		latestVersion,
		minimumSupportedVersion: MINIMUM_SUPPORTED_VERSION,
		npmPackageName: PLUGIN_PACKAGE_NAME,
		npmGlobalPackageVersion: null,
		installAction: {
			kind: "update",
			label: "Update",
			command: "bb plugin update provider-pi-durable",
		},
		needsUpdate,
		versionUnsupported,
	};
}

export async function getProviderInstallationRun(
	action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
	const status = await getProviderInstallationStatus({ checkUpdates: false });
	if (action !== "install" && action !== "update") {
		return { available: false, message: `Unsupported installation action: ${String(action)}` };
	}
	const verification =
		status.latestVersion !== null
			? { kind: "version_at_least" as const, version: status.latestVersion }
			: { kind: "version_changed" as const, previousVersion: status.currentVersion ?? "0.0.0-unknown" };

	return {
		available: true,
		command: {
			command: "bb",
			args: ["plugin", "update", "provider-pi-durable"],
			displayCommand: "bb plugin update provider-pi-durable",
		},
		verification,
	};
}
