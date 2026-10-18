import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{SessionRegistry}from'../../src/provider/host/session-registry.ts';
import{stableRootProviderId}from'../../src/bootstrap/provider-grant.ts';
test('normal SDK worker defaults to stable native identity, not a managed timestamp',()=>{const dir=mkdtempSync(join(tmpdir(),'bb-native-default-'));const registry=new SessionRegistry(()=>{},dir);assert.equal(registry.resolveProviderIdentity('thr_native_default'),stableRootProviderId('thr_native_default'));});
test('a legacy managed identity cannot silently become an empty native session',async()=>{const dir=mkdtempSync(join(tmpdir(),'bb-native-legacy-'));const registry=new SessionRegistry(()=>{},dir);await assert.rejects(registry.createOrGet('thr_native_default','pi_durable_12345',{cwd:dir}),/NATIVE_LEGACY_SESSION_REQUIRES_EXPLICIT_MIGRATION/);});
