import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { RegistryReader } from '@earendil-works/pi-durable';
import { createChildObservationService, type ChildObservationOptions } from "../native/child-observation.ts";
import { registerReadService } from "../local-host/read-service.ts";
import { readOwnerGrant as readVerifiedOwnerGrant } from "../bootstrap/owner-grant.ts";

export type RegistryAdapter = (base: RegistryReader) => RegistryReader | Promise<RegistryReader>;
// The bootstrap owner owns file validation, schema and operator/provisioner trust.
// This is its verified return capability, not an alternative grant parser.
export type VerifiedOwnerGrant = Pick<ChildObservationOptions, 'ownerScope' | 'socketPath'>;
export type VerifiedOwnerGrantReader = (path: string) => Promise<VerifiedOwnerGrant>;
export type BBExtensionOptions = {
  readonly installNativeGlobal: RegistryAdapter;
  readonly grantPath?: string;
  /** Build/source revision of this composition AND the selected native factory. */
  readonly revision: string;
  /** Trusted build/test seam; production defaults to bootstrap's bounded private-file reader. */
  readonly readOwnerGrant?: VerifiedOwnerGrantReader;
};

/** Normal registry adapter; resources are owned exclusively by the existing bind/close handoff. */
export function composeBBExtension(options: BBExtensionOptions): RegistryAdapter {
  const { installNativeGlobal, grantPath, revision, readOwnerGrant = readVerifiedOwnerGrant } = options;
  if (typeof installNativeGlobal !== 'function' || typeof revision !== 'string' || !revision.trim())
    throw Error('BB_EXTENSION_INVALID_COMPOSITION');
  if (grantPath !== undefined && (typeof grantPath !== 'string' || !grantPath.trim()))
    throw Error('BB_EXTENSION_INVALID_GRANT_PATH');
  if (grantPath !== undefined && typeof readOwnerGrant !== 'function')
    throw Error('BB_EXTENSION_VERIFIED_GRANT_READER_REQUIRED');

  return async base => {
    // Fail config preparation before invoking native composition. No ENOENT or
    // invalid-grant fallback to authorization. Reader must perform bounded I/O.
    const grant = grantPath === undefined ? undefined : await readOwnerGrant!(grantPath);
    if (grantPath !== undefined && !grant) throw Error('BB_EXTENSION_VERIFIED_GRANT_REQUIRED');
    const definition = grant && createChildObservationService({
      ownerScope: grant.ownerScope,
      socketPath: grant.socketPath,
      // Configuration is semantic: key order/relative spellings cannot mask or
      // spuriously request a rebind. Never place raw capability paths in diagnostics.
      revision: 'bb-observation/v1:' + createHash('sha256').update(JSON.stringify([
        revision, grant.ownerScope.providerId, grant.ownerScope.sessionId,
        grant.ownerScope.parentThreadId, resolve(grant.socketPath), resolve(grantPath!),
      ])).digest('hex'),
    });
    // Actual trusted native composition is injected by the build owner, not
    // reimplemented, runtime-imported, or retried here. Preserve all its guards.
    const registry = await installNativeGlobal(base);
    // undefined is an explicit disabled/removal baseline, not skipped registration.
    // On rejection never close the returned controller: it may be the OLD owner.
    return registerReadService(registry, definition && { ...definition,
      registration: { grantPath: grantPath!, ownerScope: grant!.ownerScope } });
  };
}
