import { rootAttachmentContextSchema, rootProfileFingerprint, type RootAttachmentContext } from "../bb-contracts/packages/host-daemon-contract/src/native-root-attachment.ts";
import { attachmentPayloadFingerprint, readOperatorEnrollment } from "./operator-profile-enrollment.ts";
import { readOperatorRootProfile } from "./operator-profile.ts";
/** Validate LOCAL routing against a claimed admission envelope; only later Core reverse confirmation grants authority. */
export async function readPreparedRootProfile(dataDir: string, threadId: string, context: unknown) {
  const admission: RootAttachmentContext = Object.freeze(rootAttachmentContextSchema.parse(context));
  if (admission.threadId !== threadId) throw Error('BB_OPERATOR_PROFILE_ADMISSION_ROOT_MISMATCH');
  const config = await readOperatorRootProfile(dataDir, threadId);
  const enrollment = await readOperatorEnrollment(dataDir, { requestId: admission.requestId, hostId: admission.hostId,
    projectId: admission.projectId, environmentId: admission.environmentId, providerId: admission.providerId });
  if (config.grantPath !== enrollment.grantPath || config.descriptorPath !== enrollment.descriptorPath
    || attachmentPayloadFingerprint(enrollment) !== admission.enrollmentFingerprint)
    throw Error('BB_OPERATOR_PROFILE_ADMISSION_FINGERPRINT_MISMATCH');
  const profile = { protocol: 'bb-durable-operator-profile/v1' as const, threadId, ...config };
  if (rootProfileFingerprint(threadId, admission.enrollmentFingerprint, profile) !== admission.rootProfileFingerprint)
    throw Error('BB_OPERATOR_PROFILE_ROOT_FINGERPRINT_MISMATCH');
  return { config, admission, selected: enrollment.nativeContext };
}
