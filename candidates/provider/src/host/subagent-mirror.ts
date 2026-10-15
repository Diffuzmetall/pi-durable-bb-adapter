export interface SubagentMirrorRecord {
	status: "running" | "completed";
	task: string;
	parentToolCallId?: string;
	result?: string;
}

export class SubagentMirrorManager {
	private mirrors = new Map<string, SubagentMirrorRecord>();
	private pendingByTask = new Map<string, string>();

	public markActive(
		conversationId: string | number,
		meta: { task: string; parentToolCallId?: string },
	): void {
		const key = String(conversationId);
		this.mirrors.set(key, {
			status: "running",
			task: meta.task,
			parentToolCallId: meta.parentToolCallId,
		});
		if (meta.task.trim()) {
			this.pendingByTask.set(meta.task.trim(), key);
		}
	}

	public markCompleted(conversationId: string | number, result?: string): void {
		const key = String(conversationId);
		const existing = this.mirrors.get(key);
		if (existing) {
			existing.status = "completed";
			existing.result = result;
		} else {
			this.mirrors.set(key, {
				status: "completed",
				task: "",
				result,
			});
		}
	}

	public consumeCompleted(conversationId: string | number): void {
		const key = String(conversationId);
		const record = this.mirrors.get(key);
		if (record) {
			if (record.task.trim()) {
				this.pendingByTask.delete(record.task.trim());
			}
			this.mirrors.delete(key);
		}
	}

	public getState(conversationId: string | number): SubagentMirrorRecord | undefined {
		return this.mirrors.get(String(conversationId));
	}

	public findConversationForTask(task: string): string | undefined {
		return this.pendingByTask.get(task.trim());
	}
}
