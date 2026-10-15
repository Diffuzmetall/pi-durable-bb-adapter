import { promptInputSchema } from "./types.ts";

export function extractInputText(input: unknown): string {
	const parsed = promptInputSchema.safeParse(input);
	if (!parsed.success) return "";
	return parsed.data
		.filter((chunk) => chunk.type === "text")
		.map((chunk: any) => chunk.text)
		.join("\n")
		.trim();
}

export function isCompactCommand(input: unknown): boolean {
	if (!Array.isArray(input)) return false;
	for (const chunk of input) {
		if (chunk && typeof chunk === "object" && chunk.type === "text") {
			if (Array.isArray(chunk.mentions)) {
				for (const mention of chunk.mentions) {
					if (
						mention?.resource?.kind === "command" &&
						mention?.resource?.trigger === "/" &&
						mention?.resource?.name === "compact"
					) {
						return true;
					}
				}
			}
			if (typeof chunk.text === "string" && /(?:^|\n)\s*\/compact(?:\s|$)/m.test(chunk.text)) {
				return true;
			}
		}
	}
	return false;
}

export function extractCompactInstructions(input: unknown): string | undefined {
	if (!Array.isArray(input)) return undefined;
	for (const chunk of input) {
		if (chunk && typeof chunk === "object" && chunk.type === "text" && typeof chunk.text === "string") {
			const match = /(?:^|\n)\s*\/compact(?:\s+(.*))?$/m.exec(chunk.text);
			if (match) {
				const instructions = (match[1] || "").trim();
				return instructions || undefined;
			}
		}
	}
	return undefined;
}
