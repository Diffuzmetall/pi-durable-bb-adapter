import { defineDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";

export type SubagentRecord = {
	name: string;
	conversationId: ConversationId;
	requestId: string;
	task: string;
	role: string;
	ownerTaskId: TaskId;
	background: boolean;
	reporter?: TaskId;
	report?: string;
	settled?: boolean;
};

export type PendingSubagentReport = { id: string; name: string; text: string };

export const SubagentsDoc = defineDoc<{
	agents: Record<string, SubagentRecord>;
	outbox?: PendingSubagentReport[];
	courier?: TaskId;
	batchNumber?: number;
	sending?: { requestId: string; reports: PendingSubagentReport[] };
	deliveryHold?: { kind: "admission" | "uncertain"; requestId: string; reason: string };
}>({
	kind: "bb.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});
