import { Socket } from "node:net";
import { writeSync } from "node:fs";
import { attachJsonlLineReader } from "./jsonl.ts";

const CHILD_TO_BRIDGE_FD = 3;
const BRIDGE_TO_CHILD_FD = 4;

export function createBridgeSender(): (msg: unknown) => void {
	return (msg: unknown) => {
		const str = `${JSON.stringify(msg)}\n`;
		try {
			writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EBADF") {
				console.warn(`[BridgeChannel] FD ${CHILD_TO_BRIDGE_FD} write warning: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}

export function initBridgeInboundChannel(
	modelScope: unknown,
	sendToBridge: (msg: unknown) => void,
): void {
	try {
		const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
		bridgeIn.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EBADF") {
				console.warn(`[BridgeChannel] Inbound socket warning: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		bridgeIn.unref();

		attachJsonlLineReader(bridgeIn, (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const req = JSON.parse(trimmed);
				if (req.kind === "request") {
					if (req.method === "model-scope") {
						sendToBridge({ kind: "reply", id: req.id, result: modelScope });
					} else if (req.method === "refresh-models") {
						sendToBridge({ kind: "reply", id: req.id, result: { refreshed: true } });
					} else if (req.method === "leaf") {
						sendToBridge({ kind: "reply", id: req.id, result: { leafId: null } });
					} else {
						sendToBridge({ kind: "reply", id: req.id, result: {} });
					}
				}
			} catch (err) {
				console.error("[Runner] Failed to parse or process bridge channel message:", err);
			}
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "EBADF") {
			console.warn(`[BridgeChannel] Inbound channel setup notice: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
