import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const esmRequire = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));

export function getPiDurableVersion(): string {
	try {
		const durablePkg = esmRequire.resolve("@earendil-works/pi-durable/package.json");
		if (existsSync(durablePkg)) {
			const parsed = JSON.parse(readFileSync(durablePkg, "utf8"));
			if (parsed.version) return parsed.version;
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "MODULE_NOT_FOUND" && code !== "ENOENT") {
			console.warn(`[Version] Failed to resolve durable package: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	try {
		const pluginPkg = join(currentDir, "..", "..", "package.json");
		if (existsSync(pluginPkg)) {
			const parsed = JSON.parse(readFileSync(pluginPkg, "utf8"));
			const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
			if (dep) return dep;
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") {
			console.warn(`[Version] Failed to read plugin package: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return "1.0.0";
}
