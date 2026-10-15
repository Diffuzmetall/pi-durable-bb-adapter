/**
 * Utilities for normalizing file paths and synthesizing canonical git unified diffs.
 */

/**
 * Normalizes a file path by:
 * 1. Normalizing path separators to '/'
 * 2. Relativizing against cwd if absolute and within cwd
 * 3. Stripping leading './' or '/'
 * 4. Stripping spurious git diff prefixes 'a/' or 'b/'
 */
export function normalizeFilePath(rawPath: unknown, _fallbackCwd?: string): string {
	if (typeof rawPath !== "string") return "";
	let p = rawPath.trim().replace(/\\/g, "/");
	if (p.length === 0) return "";

	if (p.startsWith("./")) {
		p = p.slice(2);
	}

	if (p.startsWith("a/") || p.startsWith("b/")) {
		p = p.slice(2);
	}

	return p;
}

/**
 * Synthesizes a canonical unified git diff for a newly created file.
 */
export function synthesizeAddDiff(cleanPath: string, content = ""): string {
	const normalizedPath = normalizeFilePath(cleanPath);
	if (!normalizedPath) return "";
	const gitPath = normalizedPath.replace(/^\/+/, "");

	if (content.length === 0) {
		return [
			`diff --git a/${gitPath} b/${gitPath}`,
			"--- /dev/null",
			`+++ b/${gitPath}`,
			"@@ -0,0 +0,0 @@",
			"",
		].join("\n");
	}

	const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalizedContent.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const lineCount = lines.length;
	if (lineCount === 0) {
		return [
			`diff --git a/${gitPath} b/${gitPath}`,
			"--- /dev/null",
			`+++ b/${gitPath}`,
			"@@ -0,0 +0,0 @@",
			"",
		].join("\n");
	}

	const header = [
		`diff --git a/${gitPath} b/${gitPath}`,
		"--- /dev/null",
		`+++ b/${gitPath}`,
		`@@ -0,0 +1,${lineCount} @@`,
	];
	const body = lines.map((line) => `+${line}`);
	return [...header, ...body, ""].join("\n");
}

/**
 * Normalizes an existing patch or diff to ensure standard git headers with clean file paths.
 */
export function normalizeGitPatch(
	rawPatch: string,
	cleanPath: string,
	kind: "add" | "update" = "update",
): string {
	const normalizedPath = normalizeFilePath(cleanPath);
	if (!rawPatch || !normalizedPath) return rawPatch || "";
	const gitPath = normalizedPath.replace(/^\/+/, "");

	const hasFileHeaders =
		rawPatch.startsWith("diff --git") ||
		rawPatch.startsWith("Index:") ||
		rawPatch.includes("\n--- ") ||
		rawPatch.startsWith("--- ") ||
		rawPatch.includes("\n+++ ") ||
		rawPatch.startsWith("+++ ");

	if (!hasFileHeaders) {
		return rawPatch;
	}

	const hunkIndex = rawPatch.indexOf("@@");
	if (hunkIndex === -1) {
		return rawPatch;
	}

	const hunks = rawPatch.slice(hunkIndex).trimEnd();
	const oldHeader = kind === "add" ? "/dev/null" : `a/${gitPath}`;
	const newHeader = `b/${gitPath}`;

	return [
		`diff --git a/${gitPath} b/${gitPath}`,
		`--- ${oldHeader}`,
		`+++ ${newHeader}`,
		hunks,
		"",
	].join("\n");
}

export interface FileChangeEventInput {
	details?: unknown;
	args?: unknown;
	[key: string]: unknown;
}

/**
 * Enriches a fileChange tool item with normalized paths and synthesized or normalized git diffs.
 */
export function resolveFileChangeItem(
	item: Record<string, unknown>,
	event: FileChangeEventInput,
	fallbackCwd: string,
): Record<string, unknown> {
	if (item.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) {
		return item;
	}

	const detailsObj = typeof event.details === "object" && event.details !== null
		? (event.details as Record<string, unknown>)
		: undefined;
	const rawDiff = typeof detailsObj?.diff === "string"
		? detailsObj.diff
		: typeof detailsObj?.patch === "string"
			? detailsObj.patch
			: undefined;

	const firstChange = item.changes[0];
	const firstChangeObj = typeof firstChange === "object" && firstChange !== null
		? (firstChange as Record<string, unknown>)
		: undefined;

	const cleanPath = typeof firstChangeObj?.path === "string"
		? normalizeFilePath(firstChangeObj.path, fallbackCwd)
		: "";

	let diff = rawDiff;
	if (!diff && firstChangeObj?.kind === "add") {
		const argsObj = typeof event.args === "object" && event.args !== null
			? (event.args as Record<string, unknown>)
			: undefined;
		const newText = typeof firstChangeObj.newText === "string"
			? firstChangeObj.newText
			: typeof argsObj?.content === "string"
				? argsObj.content
				: "";
		diff = synthesizeAddDiff(cleanPath, newText);
	} else if (diff && cleanPath) {
		const kind = firstChangeObj?.kind === "add" ? "add" : "update";
		diff = normalizeGitPatch(diff, cleanPath, kind);
	}

	return {
		...item,
		changes: item.changes.map((change: unknown, index: number) => {
			if (typeof change === "object" && change !== null) {
				const ch = change as Record<string, unknown>;
				const normalizedPath = typeof ch.path === "string"
					? normalizeFilePath(ch.path, fallbackCwd)
					: ch.path;
				if (index === 0 && diff) {
					return { ...ch, path: normalizedPath, diff };
				}
				return { ...ch, path: normalizedPath };
			}
			return change;
		}),
	};
}
