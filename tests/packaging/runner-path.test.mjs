import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveRunnerPath} from '../../src/provider/host/paths.ts';

test('the portable nested source layout resolves its own built runner without a BB installation',()=>{
 const empty=mkdtempSync(join(tmpdir(),'bb-runner-path-'));
 const expected=fileURLToPath(new URL('../../dist/runner/index.js',import.meta.url));
 assert.equal(resolveRunnerPath({bbDbPath:join(empty,'missing.db'),cacheDir:join(empty,'cache'),env:{BB_DATA_DIR:empty}}),expected);
});
