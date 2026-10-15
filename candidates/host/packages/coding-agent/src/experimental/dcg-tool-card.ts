import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, TruncatedText } from "@earendil-works/pi-tui";

/** One stable prefix around the real card; never promote live progress or generic errors to a guard receipt. */
export class DcgToolCard extends Container {
	readonly #body: Component;
	#diagnostic = "";

	constructor(body: Component) {
		super();
		this.#body = body;
		this.addChild(body);
	}

	committed(result: ToolResultMessage, data: unknown): void {
		// Harness commits diagnostics separately from stdout/model content. Never infer provenance from text.
		let diagnostic = "";
		if (result.isError === true && data && typeof data === "object" && !Array.isArray(data)) {
			const diagnostics = (data as Record<string, unknown>).diagnostics;
			if (Array.isArray(diagnostics)) {
				for (const value of diagnostics) {
					if (!value || typeof value !== "object" || Array.isArray(value)) continue;
					const item = value as Record<string, unknown>;
					const message = item.message;
					if (
						item.severity === "error" &&
						item.code === "tool_error" &&
						typeof message === "string" &&
						message.length <= 8192 &&
						Buffer.byteLength(message) <= 8192 &&
						message.isWellFormed() &&
						/^DCG_(?:DENIED|UNAVAILABLE): \S.*$/u.test(message) &&
						!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(message)
					) {
						diagnostic = message;
						break;
					}
				}
			}
		}
		if (diagnostic === this.#diagnostic) return;
		this.#diagnostic = diagnostic;
		this.clear();
		if (diagnostic) this.addChild(new TruncatedText(diagnostic, 0, 0));
		this.addChild(this.#body);
	}
}
