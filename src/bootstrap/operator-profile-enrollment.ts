import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { assertPrivateOwnerParent, readPrivateOwnerJson } from "./owner-grant.ts";
import { readSelectedNativeSession, operatorGrantConfig, type OperatorGrantConfig, type SelectedNativeSession } from "./provider-grant.ts";
import { provisionPrivateOperatorFile } from "./operator-profile.ts";
export type OperatorAttachmentSelectors = Readonly<{ requestId: string; hostId: string; projectId: string; environmentId: string; providerId: 'pi-durable' }>;
export type OperatorEnrollment = OperatorAttachmentSelectors & Readonly<OperatorGrantConfig> & Readonly<{ protocol: 'bb-durable-operator-enrollment/v1'; nativeContext: SelectedNativeSession }>;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
function selectors(value: OperatorAttachmentSelectors): void {
  if (Object.keys(value).length !== 5 || !['requestId','hostId','projectId','environmentId','providerId'].every(k => Object.hasOwn(value,k))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
    || value.providerId !== 'pi-durable' || [value.hostId, value.projectId, value.environmentId].some(v => typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length > 256))
    throw Error('BB_OPERATOR_ENROLLMENT_SELECTORS_INVALID');
}
export function operatorEnrollmentPath(sdkDataDir: string, requestId: string): string {
  if (!isAbsolute(sdkDataDir) || resolve(sdkDataDir) !== sdkDataDir || sdkDataDir.includes('\0')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw Error('BB_OPERATOR_ENROLLMENT_LOCATION_INVALID');
  return join(sdkDataDir, 'observation-roots', requestId + '.enrollment.json');
}
/** Root ID intentionally absent: normal Core assigns it AFTER this immutable payload. */
export function nativeContextFingerprint(value: OperatorEnrollment): string {
  const selected = value.nativeContext;
  return sha(['bb-durable-native-context/v1', value.grantPath, value.descriptorPath,
    selected.socket, selected.session.id, selected.session.directory, selected.session.cwd]);
}
/** SINGLE encoding from core/root-attach/CONTRACT.md; no normalization or caller-supplied hash. */
export function attachmentPayloadFingerprint(value: OperatorEnrollment): string {
  return sha(['bb-native-root-attachment/v1', value.requestId, value.hostId, value.projectId,
    value.environmentId, value.providerId, nativeContextFingerprint(value)]);
}
async function validateLocalContext(sdkDataDir: string, config: OperatorGrantConfig, snapshot?: unknown): Promise<SelectedNativeSession> {
  await assertPrivateOwnerParent(config.grantPath);
  const selected = await readSelectedNativeSession(config.descriptorPath);
  if (snapshot !== undefined && !isDeepStrictEqual(snapshot, selected)) throw Error('BB_OPERATOR_ENROLLMENT_NATIVE_CONTEXT_CHANGED');
  const within = relative(selected.session.cwd, sdkDataDir);
  if (within === '' || (!within.startsWith('..' + '/') && within !== '..' && !isAbsolute(within)))
    throw Error('BB_OPERATOR_ENROLLMENT_MUST_BE_OUTSIDE_WORKSPACE');
  return selected;
}
/** LOCAL OS operator only. No grant/binding/Root creation or native RPC occurs. */
export async function provisionOperatorEnrollment(sdkDataDir: string, scope: OperatorAttachmentSelectors, config: OperatorGrantConfig): Promise<OperatorEnrollment> {
  selectors(scope);
  const checked = operatorGrantConfig({ PI_DURABLE_OWNER_GRANT_PATH: config.grantPath, PI_DURABLE_SELECTED_SESSION_DESCRIPTOR: config.descriptorPath });
  if (!checked) throw Error('BB_OPERATOR_ENROLLMENT_INVALID');
  const nativeContext = await validateLocalContext(sdkDataDir, checked);
  const value: OperatorEnrollment = Object.freeze({ protocol: 'bb-durable-operator-enrollment/v1', ...scope, ...checked, nativeContext });
  await provisionPrivateOperatorFile(operatorEnrollmentPath(sdkDataDir, scope.requestId), value);
  return value;
}
/** CURRENT authenticated daemon supplies expected Core-derived scope, never an HTTP proof boolean. */
export async function readOperatorEnrollment(sdkDataDir: string, expected: OperatorAttachmentSelectors): Promise<OperatorEnrollment> {
  selectors(expected);
  const value = await readPrivateOwnerJson(operatorEnrollmentPath(sdkDataDir, expected.requestId));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('BB_OPERATOR_ENROLLMENT_INVALID');
  const v = value as Record<string, unknown>;
  const keys = ['protocol','requestId','hostId','projectId','environmentId','providerId','grantPath','descriptorPath','nativeContext'];
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k)) || v.protocol !== 'bb-durable-operator-enrollment/v1'
    || Object.entries(expected).some(([key, item]) => v[key] !== item) || typeof v.grantPath !== 'string' || typeof v.descriptorPath !== 'string')
    throw Error('BB_OPERATOR_ENROLLMENT_SCOPE_MISMATCH');
  const config = operatorGrantConfig({ PI_DURABLE_OWNER_GRANT_PATH: v.grantPath, PI_DURABLE_SELECTED_SESSION_DESCRIPTOR: v.descriptorPath });
  if (!config) throw Error('BB_OPERATOR_ENROLLMENT_INVALID');
  const nativeContext = await validateLocalContext(sdkDataDir, config, v.nativeContext);
  return Object.freeze({ protocol: 'bb-durable-operator-enrollment/v1', ...expected, ...config, nativeContext });
}
