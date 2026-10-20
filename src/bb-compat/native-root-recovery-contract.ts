import { createHash } from 'node:crypto';
import { z } from 'zod';

export const rootRecoveryDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selector = { threadId: z.string().regex(/^thr_[A-Za-z0-9_-]+$/).max(200), providerThreadId: z.string().min(1).max(1025) };
export const rootRecoverySnapshotSchema = z.object({
  sessionId: z.string().min(1).max(512), conversationId: z.literal(1),
  userEntryId: z.number().int().positive().safe(), answerEntryId: z.number().int().positive().safe(),
  inputs: z.array(z.object({ entryId: z.number().int().positive().safe(), text: z.string().min(1).max(512 * 1024) }).strict()).min(1).max(1000),
  answerText: z.string().min(1).max(512 * 1024),
  status: z.enum(['completed', 'failed', 'interrupted']),
}).strict().refine(value => value.answerEntryId > value.userEntryId && value.inputs.at(-1)?.entryId === value.userEntryId &&
  value.inputs.every((input, index) => !index || value.inputs[index - 1].entryId < input.entryId), 'Ordered native input lineage required');
export const rootRecoveryRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), ...selector }).strict(),
  z.object({ operation: z.literal('apply'), ...selector, backupDigest: digest, snapshot: rootRecoverySnapshotSchema }).strict(),
]);
export type RootRecoveryRequest = z.infer<typeof rootRecoveryRequestSchema>;
export type RootRecoverySnapshot = z.infer<typeof rootRecoverySnapshotSchema>;
export const rootRecoveryBackupSchema = z.object({
  protocol: z.literal('bb-native-root-recovery-backup/v1'), hostId: z.string().min(1),
  threadId: selector.threadId, providerThreadId: selector.providerThreadId,
  thread: z.record(z.string(), z.unknown()), events: z.array(z.record(z.string(), z.unknown())),
  metadata: z.record(z.string(), z.unknown()),
}).strict();
export type RootRecoveryBackup = z.infer<typeof rootRecoveryBackupSchema>;
export const rootRecoveryReceiptSchema = z.object({ version: z.literal(1), backupDigest: digest,
  snapshotDigest: digest, afterStateDigest: digest, turnId: z.string().min(1).max(256), itemId: z.string().min(1).max(256) }).strict();
