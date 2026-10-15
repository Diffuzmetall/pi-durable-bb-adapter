export function sendJsonRpcResult(
	sendRaw: (json: string) => void,
	id: string | number,
	result: Record<string, unknown>,
): void {
	sendRaw(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

export function sendJsonRpcError(
	sendRaw: (json: string) => void,
	id: string | number,
	code: number,
	message: string,
): void {
	sendRaw(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export function sendJsonRpcNotification(
	sendRaw: (json: string) => void,
	method: string,
	params: Record<string, unknown>,
): void {
	sendRaw(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
