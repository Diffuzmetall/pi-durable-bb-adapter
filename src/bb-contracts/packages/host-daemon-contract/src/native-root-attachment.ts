import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { OperatorEnrollment } from "../../../../bootstrap/operator-profile-enrollment.ts";
export { nativeContextFingerprint, attachmentPayloadFingerprint, operatorEnrollmentPath } from "../../../../bootstrap/operator-profile-enrollment.ts";
export { operatorProfilePath } from "../../../../bootstrap/operator-profile.ts";
export type { OperatorEnrollment, OperatorAttachmentSelectors } from "../../../../bootstrap/operator-profile-enrollment.ts";

const id = z.string().min(1).max(256).refine(v => v.trim() === v && !v.includes("\0"));
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const path = z.string().min(1).max(4096).refine(v => !v.includes("\0") && isAbsolute(v) && resolve(v) === v);
export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const rootRequestSchema = z.object({ requestId: uuid, projectId: id, environmentId: id, providerId: z.literal("pi-durable") }).strict();
export const rootOperatorProfileSchema = z.object({ protocol: z.literal("bb-durable-operator-profile/v1"), threadId: id,
  grantPath: path, descriptorPath: path }).strict();
// Wire schema only. Existing1496 codec/reader owns E9 validation and ALL enrollment encodings.
export const rootEnrollmentProofSchema: z.ZodType<OperatorEnrollment> = rootRequestSchema.extend({
  protocol: z.literal("bb-durable-operator-enrollment/v1"), hostId: id, grantPath: path, descriptorPath: path,
  nativeContext: z.object({socket:path,session:z.object({id,directory:path,cwd:path}).strict()}).strict(),
}).strict();
export type RootRequest = z.infer<typeof rootRequestSchema>;
export type RootOperatorProfile = z.infer<typeof rootOperatorProfileSchema>;
/** Only NEW fingerprint: original enrollment remains unchanged when Core supplies its root ID. */
export function rootProfileFingerprint(threadId: string, enrollmentFingerprint: string, profile: RootOperatorProfile): string {
  id.parse(threadId); fingerprintSchema.parse(enrollmentFingerprint);
  const p = rootOperatorProfileSchema.parse(profile);
  if (p.threadId !== threadId) throw Error("ROOT_PROFILE_ID_MISMATCH");
  return createHash("sha256").update(JSON.stringify(["bb-native-root-profile/v1", enrollmentFingerprint, threadId,
    p.protocol, p.threadId, p.grantPath, p.descriptorPath]), "utf8").digest("hex");
}
export const rootChallengeSchema = z.object({ type: z.literal("native-root.attachment"), phase: z.enum(["enrollment", "profile", "start"]),
  challengeId: uuid, daemonSessionId: id, hostId: id, request: rootRequestSchema,
  threadId: id.optional(), enrollmentFingerprint: fingerprintSchema.optional(), rootProfileFingerprint: fingerprintSchema.optional() }).strict()
  .superRefine((v,ctx) => {
    if (v.phase !== "enrollment" && (!v.threadId || !v.enrollmentFingerprint)) ctx.addIssue({code:"custom",message:"Reserved root receipt required"});
    if (v.phase === "start" && !v.rootProfileFingerprint) ctx.addIssue({code:"custom",message:"Frozen root profile required"});
    if (v.phase === "enrollment" && (v.threadId !== undefined || v.enrollmentFingerprint !== undefined || v.rootProfileFingerprint !== undefined))
      ctx.addIssue({code:"custom",message:"Enrollment cannot claim a root receipt"});
  });
export const rootChallengeReplySchema = z.discriminatedUnion("status", [
  z.object({status:z.literal("enrollment-required"),challengeId:uuid,enrollmentFile:path}).strict(),
  z.object({status:z.literal("validated"),challengeId:uuid,hostId:id,request:rootRequestSchema,
    enrollment:rootEnrollmentProofSchema,enrollmentFingerprint:fingerprintSchema,enrollmentFile:path,
    profileFile:path.optional(),profile:rootOperatorProfileSchema.optional(),rootProfileFingerprint:fingerprintSchema.optional(),processGeneration:id.optional()}).strict(),
]);
export const rootAttachmentContextSchema = rootRequestSchema.extend({protocol:z.literal("bb-native-root-admission/v1"),
  threadId:id,hostId:id,enrollmentFingerprint:fingerprintSchema,rootProfileFingerprint:fingerprintSchema}).strict();
export type RootAttachmentContext = z.infer<typeof rootAttachmentContextSchema>;
export const confirmRootAttachmentSchema = z.object({providerThreadId:id,enrollmentFingerprint:fingerprintSchema,
  rootProfileFingerprint:fingerprintSchema}).strict();
