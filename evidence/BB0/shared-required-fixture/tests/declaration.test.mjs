import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeclaration } from '../overlay/fixture-admission.mjs';

test('a valid pure declaration is admitted, but not catalog/runtime', () => {
  const root = '/synthetic/private-fixture';
  const now = Date.now();
  const k = 'bb0_324d2aa5-1636-4af2-8895-7b620958ed74';
  const declaration = {
    version: 1, mode: 'shared-required-stage1', fixtureId: '24542341-aaf8-4864-8dc4-48b0dc4921b0',
    sessionKey: k, expectedThreadId: 'synthetic-thread',
    bindingDirectory: `${root}/bindings/${k}`, cwd: `${root}/work`, socket: `${root}/s`,
    createdAt: now, expiresAt: now + 300000,
  };
  const result = validateDeclaration(declaration, root, now);
  assert.equal(result.sessionKey, k);
  assert.equal(result.runtimeAdmission, 'UNAVAILABLE');
  assert.throws(() => validateDeclaration({ ...declaration, sessionKey: '../escape' }, root, now), /DECLARATION_KEY/);
  assert.throws(() => validateDeclaration({ ...declaration, expiresAt: now - 1 }, root, now), /DECLARATION_STALE/);
});
